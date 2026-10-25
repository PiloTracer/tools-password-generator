#!/usr/bin/env python3
"""Generate or reuse the application's scoped, read-only Secrets Manager client.

Writes a Docker Compose override file that:
  * augments SM_CLIENTS_JSON with the application client (static, read-only), and
  * sets the app container's AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY to that
    client instead of the full-access instance credential.

The override file is read by bin/start.sh through the compose() wrapper.  The
application credential is persisted under RUN_DIR so it survives restarts and
is regenerated (without touching production data) if that file is lost.

Usage:
    ensure-app-credentials.py RUN_DIR ENV_NAME SM_CLIENTS_JSON [PRIMARY_ACCESS_KEY_ID]

PRIMARY_ACCESS_KEY_ID is optional; when supplied it is treated as reserved so a
generated client can never collide with the instance administrator.
"""
import json
import os
import secrets
import sys
import tempfile


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def write_atomic(path, data, mode=0o600):
    directory = os.path.dirname(path)
    try:
        os.makedirs(directory, exist_ok=True)
        os.chmod(directory, 0o700)
    except OSError as exc:
        fail(f"Unable to prepare a private directory {directory}: {exc}")

    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1  # Ownership moved to the handle.
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        os.chmod(path, mode)
    except BaseException:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def is_true(value):
    return value is True or str(value or "").strip().lower() == "true"


def is_app_client(client, app_prefix):
    if not isinstance(client, dict):
        return False
    if not is_true(client.get("readOnly")):
        return False
    prefixes = client.get("allowedPrefixes")
    if not isinstance(prefixes, list):
        return False
    normalized = {
        str(prefix).strip().rstrip("/") + "/"
        for prefix in prefixes
        if str(prefix).strip()
    }
    if app_prefix not in normalized:
        return False
    if not client.get("accessKeyId") or not client.get("secretAccessKey"):
        return False
    return True


def find_conflict(client, clients, primary_access_key_id):
    """Return a human-readable conflict, or None when the client is safe to add."""
    name = str(client.get("name") or "")
    access_key_id = str(client.get("accessKeyId") or "")
    if primary_access_key_id and access_key_id == primary_access_key_id:
        return "the instance administrator access key"
    for other in clients:
        if not isinstance(other, dict) or other is client:
            continue
        if str(other.get("name") or "") == name:
            return f"client name '{name}'"
        if str(other.get("accessKeyId") or "") == access_key_id:
            return f"access key '{access_key_id[:8]}...'"
    return None


def main():
    if len(sys.argv) not in (4, 5):
        fail(
            "Usage: ensure-app-credentials.py RUN_DIR ENV_NAME SM_CLIENTS_JSON "
            "[PRIMARY_ACCESS_KEY_ID]"
        )
    run_dir = sys.argv[1]
    env_name = sys.argv[2]
    clients_raw = sys.argv[3].strip() or "[]"
    primary_access_key_id = sys.argv[4].strip() if len(sys.argv) == 5 else ""

    try:
        clients = json.loads(clients_raw)
    except json.JSONDecodeError as exc:
        fail(f"SM_CLIENTS_JSON is not valid JSON: {exc}")
    if not isinstance(clients, list):
        fail("SM_CLIENTS_JSON must be a JSON array.")

    try:
        os.makedirs(run_dir, exist_ok=True)
        os.chmod(run_dir, 0o700)
    except OSError as exc:
        fail(f"Unable to prepare the run directory {run_dir}: {exc}")

    app_prefix = f"password-generator/{env_name}/"
    persisted_path = os.path.join(run_dir, f"app-credentials.{env_name}.json")
    override_path = os.path.join(run_dir, f"compose.app-credentials.{env_name}.yml")

    # Prefer an explicit, read-only application client supplied in SM_CLIENTS_JSON.
    app = None
    source = None
    for client in clients:
        if is_app_client(client, app_prefix):
            app = client
            source = "static"
            break

    # Reuse a previously generated application client if it is still valid and
    # does not collide with the current static client set.
    if app is None and os.path.isfile(persisted_path):
        try:
            with open(persisted_path, "r", encoding="utf-8") as handle:
                persisted = json.load(handle)
        except (OSError, json.JSONDecodeError):
            persisted = None
        if isinstance(persisted, dict) and is_app_client(persisted, app_prefix):
            conflict = find_conflict(persisted, clients, primary_access_key_id)
            if conflict is None:
                app = persisted
                source = "persisted"
                try:
                    os.chmod(persisted_path, 0o600)
                except OSError as exc:
                    fail(f"Unable to restrict permissions on {persisted_path}: {exc}")

    # Generate a new application client if necessary.
    if app is None:
        existing_names = {
            str(client.get("name"))
            for client in clients
            if isinstance(client, dict)
        }
        existing_keys = {
            str(client.get("accessKeyId"))
            for client in clients
            if isinstance(client, dict)
        }
        if primary_access_key_id:
            existing_keys.add(primary_access_key_id)
        for _ in range(100):
            name = f"password-generator-{env_name}-{secrets.token_hex(4)}"
            access_key_id = "AKIA" + secrets.token_hex(8).upper()
            if name not in existing_names and access_key_id not in existing_keys:
                break
        else:
            fail("Unable to generate a unique application client name/key.")
        app = {
            "name": name,
            "accessKeyId": access_key_id,
            "secretAccessKey": secrets.token_hex(32),
            "sessionToken": "",
            "description": f"Password generator runtime ({env_name}, read-only)",
            "allowedPrefixes": [app_prefix],
            "readOnly": True,
        }
        source = "generated"
        write_atomic(persisted_path, json.dumps(app, indent=2, sort_keys=True) + "\n", 0o600)

    # Make sure the Secrets Manager actually receives the application client. This
    # is a no-op when it was supplied through SM_CLIENTS_JSON.
    if not any(
        isinstance(client, dict)
        and client.get("name") == app["name"]
        and client.get("accessKeyId") == app["accessKeyId"]
        for client in clients
    ):
        clients.append(app)

    clients_json = json.dumps(clients, separators=(",", ":"))
    override = (
        "# Generated by bin/start.sh. Do not edit by hand; delete to rotate.\n"
        "services:\n"
        "  secrets-manager:\n"
        "    environment:\n"
        f"      SM_CLIENTS_JSON: {json.dumps(clients_json)}\n"
        "  app:\n"
        "    environment:\n"
        f"      AWS_ACCESS_KEY_ID: {json.dumps(app['accessKeyId'])}\n"
        f"      AWS_SECRET_ACCESS_KEY: {json.dumps(app['secretAccessKey'])}\n"
        f"      AWS_SESSION_TOKEN: {json.dumps(str(app.get('sessionToken', '')))}\n"
    )
    write_atomic(override_path, override, 0o600)

    print(f"APP_CREDENTIAL {app['name']} {source}")


if __name__ == "__main__":
    main()
