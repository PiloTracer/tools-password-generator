#!/usr/bin/env bash
# =============================================================================
#  Secrets Manager verification
#
#  Exercises the AWS-compatible Secrets Manager the way an external client
#  application does:
#    • health/readiness endpoints,
#    • SigV4-authenticated CRUD through the AWS CLI,
#    • versions, staging labels, tags, batch reads and random passwords,
#    • soft delete -> access denied -> restore -> access,
#    • rejected requests for a wrong secret key and a wrong region,
#    • the bundled SigV4 client when the AWS CLI is unavailable,
#    • the admin-only client-credential operations on the loopback admin
#      listener and their rejection on the public listener,
#    • the application's scoped read-only credential (when provisioned),
#    • optionally a real AWS SDK v3 client (--sdk),
#    • optionally a real Python boto3 client (--boto3).
#
#  The test creates one uniquely named secret and force-deletes it on exit.
#
#  Usage:
#    ./bin/verify-secrets-manager.sh --env dev
#    ./bin/verify-secrets-manager.sh --env prd --sdk --boto3
#
#  --sdk    installs @aws-sdk/client-secrets-manager in a throwaway Node
#           container (network required), then lists secrets and reads policy.
#  --boto3  installs boto3 in a throwaway Python container and runs the
#           example client (network required).
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR" || exit 2

ENV_NAME="dev"
USE_SDK=false
USE_BOTO3=false
PASSES=0
FAILURES=0
SKIPS=0
CLIENT=""
ENDPOINT=""
SECRET_NAME=""
SECRET_CREATED=false
PROJECT=""
APP_CONFIG_SECRET_ID=""
TEMP_APP_WRITE=""
TEMP_OUTSIDE=""

usage() {
  cat <<'EOF'
Usage: ./bin/verify-secrets-manager.sh [--env dev|prd] [--sdk] [--boto3]

  --env dev|prd   Environment to verify (default: dev).
  --sdk           Also test a real AWS SDK v3 client in a Node container
                  (requires Docker network + npm registry access).
  --boto3         Also test a real Python boto3 client in a Python container
                  (requires Docker network + PyPI access).
  -h, --help      Show this help.

The Secrets Manager must already be running, for example:
  ./bin/start.sh up dev
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift ;;
    --env=*) ENV_NAME="${1#--env=}" ;;
    dev|prd) ENV_NAME="$1" ;;
    --sdk) USE_SDK=true ;;
    --boto3) USE_BOTO3=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'verify-secrets: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$ENV_NAME" in
  dev|prd) ;;
  *) printf 'verify-secrets: --env must be dev or prd\n' >&2; exit 2 ;;
esac

ENV_FILE=".env.$ENV_NAME"
COMPOSE_FILE="docker-compose.$ENV_NAME.yml"
if [ ! -f "$ENV_FILE" ]; then
  printf 'verify-secrets: missing %s\n' "$ENV_FILE" >&2
  exit 2
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  printf 'verify-secrets: missing %s\n' "$COMPOSE_FILE" >&2
  exit 2
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

PROJECT="${COMPOSE_PROJECT_NAME:-passwordgenerator_$ENV_NAME}"
APP_CONFIG_SECRET_ID="${APP_CONFIG_SECRET_ID:-password-generator/$ENV_NAME/app-config}"
BIND_ADDRESS="${SECRETS_MANAGER_BIND_ADDRESS:-127.0.0.1}"
case "$BIND_ADDRESS" in
  0.0.0.0|::|"") BIND_ADDRESS="127.0.0.1" ;;
esac
ENDPOINT="http://$BIND_ADDRESS:${SECRETS_MANAGER_PORT:-18001}"
if [ -n "${SM_ENDPOINT:-}" ]; then
  ENDPOINT="${SM_ENDPOINT%/}"
fi

export AWS_ACCESS_KEY_ID="$SECRETS_MANAGER_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$SECRETS_MANAGER_SECRET_ACCESS_KEY"
export AWS_REGION="$SECRETS_MANAGER_REGION"
export AWS_DEFAULT_REGION="$SECRETS_MANAGER_REGION"
export AWS_PAGER=""
if [ -n "${SECRETS_MANAGER_SESSION_TOKEN:-}" ]; then
  export AWS_SESSION_TOKEN="$SECRETS_MANAGER_SESSION_TOKEN"
fi

# BuildKit/exec in sandboxes with a read-only ~/.docker.
if [ -d "${DOCKER_CONFIG:-${HOME:-$ROOT_DIR}/.docker}" ] &&
   [ ! -w "${DOCKER_CONFIG:-${HOME:-$ROOT_DIR}/.docker}" ]; then
  export DOCKER_CONFIG="$ROOT_DIR/.run/docker-config"
  mkdir -p "$DOCKER_CONFIG" 2>/dev/null || true
fi

has() { command -v "$1" >/dev/null 2>&1; }
pass() { PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf 'FAIL  %s\n' "$1" >&2; }
skip() { SKIPS=$((SKIPS + 1)); printf 'SKIP  %s\n' "$1"; }
note() { printf '%s\n' "$1"; }

aws_sm() {
  aws --endpoint-url "$ENDPOINT" --region "$SECRETS_MANAGER_REGION" secretsmanager "$@"
}

compose_sm() {
  docker compose --project-directory "$ROOT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

sm_cli() {
  local endpoint="http://127.0.0.1:8080"
  if compose_sm exec -T secrets-manager node -e "fetch('http://127.0.0.1:8081/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    endpoint="http://127.0.0.1:8081"
  fi
  compose_sm exec -T -e "SM_ENDPOINT=$endpoint" secrets-manager node cli.mjs "$@"
}

# Run the bundled client inside the Secrets Manager container while overriding
# the container's instance credential with a specific principal.  Empty SM_*
# values make client.mjs fall back to the AWS_* values.
run_as_client() {
  local endpoint="$1" access_key="$2" secret_key="$3"
  shift 3
  compose_sm exec -T \
    -e SM_ACCESS_KEY_ID= \
    -e SM_SECRET_ACCESS_KEY= \
    -e SM_SESSION_TOKEN= \
    -e "AWS_ACCESS_KEY_ID=$access_key" \
    -e "AWS_SECRET_ACCESS_KEY=$secret_key" \
    -e "SM_ENDPOINT=$endpoint" \
    secrets-manager node cli.mjs "$@"
}

cleanup() {
  if [ "$SECRET_CREATED" = true ]; then
    if [ "$CLIENT" = "aws" ]; then
      aws_sm delete-secret --secret-id "$SECRET_NAME" --force-delete-without-recovery >/dev/null 2>&1 || true
    else
      sm_cli delete-secret "$SECRET_NAME" --force >/dev/null 2>&1 || true
    fi
    SECRET_CREATED=false
  fi
  local name
  for name in "$TEMP_APP_WRITE" "$TEMP_OUTSIDE"; do
    if [ -n "$name" ]; then
      sm_cli delete-secret "$name" --force >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

summary() {
  note ""
  note "== Secrets Manager verification result ($ENV_NAME) =="
  note "  Endpoint: $ENDPOINT"
  note "  Client:   $CLIENT"
  note "  Passed:   $PASSES"
  note "  Failed:   $FAILURES"
  note "  Skipped:  $SKIPS"
  if [ "$FAILURES" -gt 0 ]; then
    printf 'Secrets Manager verification FAILED.\n' >&2
    exit 1
  fi
  printf 'Secrets Manager verification PASSED.\n'
  exit 0
}

note "== Secrets Manager verification ($ENV_NAME) =="
note "Endpoint: $ENDPOINT"
note "Policy:   $APP_CONFIG_SECRET_ID"
note ""

if ! has curl; then
  printf 'verify-secrets: curl is required\n' >&2
  exit 2
fi

if ! curl -fsS --max-time 5 "$ENDPOINT/healthz" >/dev/null 2>&1; then
  fail "GET /healthz (Secrets Manager unreachable)"
  printf 'Start it with: ./bin/start.sh up %s\n' "$ENV_NAME" >&2
  exit 1
fi
pass "GET /healthz"

ready_code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$ENDPOINT/readyz" 2>/dev/null || true)"
if [ "$ready_code" = "200" ]; then
  pass "GET /readyz (200)"
else
  fail "GET /readyz (HTTP $ready_code)"
fi

SECRET_NAME="verify/sm-$ENV_NAME-$(date -u +%Y%m%dT%H%M%SZ)-$$"

if has aws; then
  CLIENT="aws"
  note "Client:   AWS CLI ($(aws --version 2>&1 | awk '{print $1}' | head -1))"
  note ""

  if aws_sm list-secrets >/dev/null 2>&1; then
    pass "aws secretsmanager list-secrets"
  else
    fail "aws secretsmanager list-secrets"
  fi

  if aws_sm create-secret \
    --name "$SECRET_NAME" \
    --description "bin/verify-secrets-manager.sh" \
    --secret-string "v1" \
    --tags Key=purpose,Value=verification >/dev/null 2>&1; then
    SECRET_CREATED=true
    pass "CreateSecret (with tags)"
  else
    fail "CreateSecret"
    summary
  fi

  value="$(aws_sm get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text 2>/dev/null || true)"
  if [ "$value" = "v1" ]; then
    pass "GetSecretValue (AWSCURRENT = v1)"
  else
    fail "GetSecretValue (AWSCURRENT)"
  fi

  if aws_sm put-secret-value --secret-id "$SECRET_NAME" --secret-string "v2" >/dev/null 2>&1; then
    pass "PutSecretValue (v2)"
  else
    fail "PutSecretValue"
  fi

  value="$(aws_sm get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text 2>/dev/null || true)"
  if [ "$value" = "v2" ]; then
    pass "GetSecretValue (new AWSCURRENT = v2)"
  else
    fail "GetSecretValue (new AWSCURRENT)"
  fi

  previous="$(aws_sm get-secret-value --secret-id "$SECRET_NAME" --version-stage AWSPREVIOUS --query SecretString --output text 2>/dev/null || true)"
  if [ "$previous" = "v1" ]; then
    pass "GetSecretValue (AWSPREVIOUS = v1)"
  else
    fail "GetSecretValue (AWSPREVIOUS)"
  fi

  if aws_sm describe-secret --secret-id "$SECRET_NAME" --query 'VersionIdsToStages' --output json 2>/dev/null | grep -q 'AWSCURRENT'; then
    pass "DescribeSecret (VersionIdsToStages)"
  else
    fail "DescribeSecret (VersionIdsToStages)"
  fi

  if aws_sm tag-resource --secret-id "$SECRET_NAME" --tags Key=owner,Value=verify >/dev/null 2>&1 &&
     aws_sm describe-secret --secret-id "$SECRET_NAME" --query 'Tags' --output json 2>/dev/null | grep -q 'owner'; then
    pass "TagResource + DescribeSecret (tags)"
  else
    fail "TagResource"
  fi

  if aws_sm list-secret-version-ids --secret-id "$SECRET_NAME" --query 'Versions[].VersionStages' --output json 2>/dev/null | grep -q 'AWSPREVIOUS'; then
    pass "ListSecretVersionIds (stages)"
  else
    fail "ListSecretVersionIds"
  fi

  batch="$(aws_sm batch-get-secret-value --secret-id-list "$SECRET_NAME" --query 'SecretValues[0].SecretString' --output text 2>/dev/null || true)"
  if [ "$batch" = "v2" ]; then
    pass "BatchGetSecretValue"
  else
    fail "BatchGetSecretValue"
  fi

  random_password="$(aws_sm get-random-password --password-length 20 --query RandomPassword --output text 2>/dev/null || true)"
  if [ "${#random_password}" -eq 20 ]; then
    pass "GetRandomPassword (length)"
  else
    fail "GetRandomPassword"
  fi

  if aws_sm delete-secret --secret-id "$SECRET_NAME" --recovery-window-in-days 7 >/dev/null 2>&1; then
    pass "DeleteSecret (soft delete)"
  else
    fail "DeleteSecret (soft delete)"
  fi

  error="$(aws_sm get-secret-value --secret-id "$SECRET_NAME" 2>&1 >/dev/null || true)"
  case "$error" in
    *InvalidRequestException*) pass "Soft-deleted secret is inaccessible (InvalidRequestException)" ;;
    *) fail "Soft-deleted secret access was not rejected as expected" ;;
  esac

  if aws_sm restore-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
    pass "RestoreSecret"
  else
    fail "RestoreSecret"
  fi

  value="$(aws_sm get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text 2>/dev/null || true)"
  if [ "$value" = "v2" ]; then
    pass "GetSecretValue after restore"
  else
    fail "GetSecretValue after restore"
  fi

  error="$( ( export AWS_SECRET_ACCESS_KEY="invalid-$(date +%s)-not-a-real-secret"; aws_sm list-secrets ) 2>&1 >/dev/null || true)"
  case "$error" in
    *InvalidSignatureException*) pass "Wrong secret key rejected (InvalidSignatureException)" ;;
    *) fail "Wrong secret key was not rejected as expected" ;;
  esac

  error="$(aws --endpoint-url "$ENDPOINT" --region eu-west-1 secretsmanager list-secrets 2>&1 >/dev/null || true)"
  case "$error" in
    *InvalidSignatureException*) pass "Wrong region rejected (InvalidSignatureException)" ;;
    *) fail "Wrong region was not rejected as expected" ;;
  esac

  if aws_sm delete-secret --secret-id "$SECRET_NAME" --force-delete-without-recovery >/dev/null 2>&1; then
    SECRET_CREATED=false
    pass "ForceDeleteWithoutRecovery (cleanup)"
  else
    fail "ForceDeleteWithoutRecovery (cleanup)"
  fi
else
  CLIENT="bundled"
  note "Client:   bundled SigV4 client (AWS CLI not installed)"
  note ""

  if sm_cli ping >/dev/null 2>&1; then
    pass "bundled client ping (ListSecrets)"
  else
    fail "bundled client ping"
    summary
  fi

  if printf 'v1' | sm_cli create-secret "$SECRET_NAME" --stdin --description "bin/verify-secrets-manager.sh" >/dev/null 2>&1; then
    SECRET_CREATED=true
    pass "CreateSecret"
  else
    fail "CreateSecret"
    summary
  fi

  value="$(sm_cli get-secret-value "$SECRET_NAME" 2>/dev/null || true)"
  if [ "$value" = "v1" ]; then
    pass "GetSecretValue (v1)"
  else
    fail "GetSecretValue (v1)"
  fi

  if printf 'v2' | sm_cli put-secret-value "$SECRET_NAME" --stdin >/dev/null 2>&1; then
    pass "PutSecretValue (v2)"
  else
    fail "PutSecretValue"
  fi

  previous="$(sm_cli get-secret-value "$SECRET_NAME" --stage AWSPREVIOUS 2>/dev/null || true)"
  if [ "$previous" = "v1" ]; then
    pass "GetSecretValue (AWSPREVIOUS)"
  else
    fail "GetSecretValue (AWSPREVIOUS)"
  fi

  if sm_cli describe-secret "$SECRET_NAME" 2>/dev/null | grep -q 'AWSCURRENT'; then
    pass "DescribeSecret"
  else
    fail "DescribeSecret"
  fi

  if sm_cli list-secrets 2>/dev/null | grep -q "$SECRET_NAME"; then
    pass "ListSecrets"
  else
    fail "ListSecrets"
  fi

  if sm_cli delete-secret "$SECRET_NAME" --force >/dev/null 2>&1; then
    SECRET_CREATED=false
    pass "DeleteSecret (cleanup)"
  else
    fail "DeleteSecret (cleanup)"
  fi
fi

if compose_sm exec -T secrets-manager node -e "fetch('http://127.0.0.1:8081/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
  pass "Admin listener is available (127.0.0.1:8081)"
else
  fail "Admin listener is unavailable (127.0.0.1:8081)"
fi

if sm_cli list-client-credentials 2>/dev/null | grep -q '"ClientCredentialList"'; then
  pass "ListClientCredentials (admin listener)"
else
  fail "ListClientCredentials (admin listener)"
fi

# All four admin operations must be rejected on the public listener.
for admin_op in CreateClientCredential DeleteClientCredential GetClientCredential ListClientCredentials; do
  public_admin_output="$(run_as_client http://127.0.0.1:8080 "$SECRETS_MANAGER_ACCESS_KEY_ID" "$SECRETS_MANAGER_SECRET_ACCESS_KEY" raw "$admin_op" '{}' 2>&1 || true)"
  if printf '%s' "$public_admin_output" | grep -q 'AccessDeniedException'; then
    pass "Public listener rejects $admin_op (AccessDeniedException)"
  else
    fail "Public listener did not reject $admin_op"
    note "  output: $public_admin_output"
  fi
done

# The app must use a scoped, read-only credential rather than the instance admin.
APP_ACCESS_KEY=""
APP_SECRET_KEY=""
APP_CONTAINER="$(compose_sm ps -q app 2>/dev/null | head -n 1)"
if [ -n "$APP_CONTAINER" ]; then
  app_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" 2>/dev/null || true)"
  APP_ACCESS_KEY="$(printf '%s\n' "$app_env" | sed -n 's/^AWS_ACCESS_KEY_ID=//p' | head -n 1)"
  APP_SECRET_KEY="$(printf '%s\n' "$app_env" | sed -n 's/^AWS_SECRET_ACCESS_KEY=//p' | head -n 1)"
  if [ -n "$APP_ACCESS_KEY" ] && [ "$APP_ACCESS_KEY" = "$SECRETS_MANAGER_ACCESS_KEY_ID" ]; then
    fail "The app container still uses the instance admin credential"
    APP_ACCESS_KEY=""
    APP_SECRET_KEY=""
  elif [ -n "$APP_ACCESS_KEY" ] && [ -n "$APP_SECRET_KEY" ]; then
    pass "The app container uses a scoped credential (not the instance admin)"
  else
    skip "The app container credential could not be read"
  fi
else
  skip "The app container is not running"
fi

if [ -n "$APP_ACCESS_KEY" ] && [ -n "$APP_SECRET_KEY" ]; then
  app_read_output="$(run_as_client http://127.0.0.1:8080 "$APP_ACCESS_KEY" "$APP_SECRET_KEY" get-secret-value "$APP_CONFIG_SECRET_ID" --json 2>&1 || true)"
  if printf '%s' "$app_read_output" | grep -q '"SecretString"'; then
    pass "App credential can read its policy secret"
  else
    fail "App credential could not read $APP_CONFIG_SECRET_ID"
  fi

  TEMP_APP_WRITE="password-generator/$ENV_NAME/verify-app-$ENV_NAME-$$"
  app_write_output="$(printf 'verify' | run_as_client http://127.0.0.1:8080 "$APP_ACCESS_KEY" "$APP_SECRET_KEY" create-secret "$TEMP_APP_WRITE" --stdin 2>&1 || true)"
  if printf '%s' "$app_write_output" | grep -q 'AccessDeniedException'; then
    pass "App credential is read-only (CreateSecret denied)"
  else
    fail "App credential was able to create a secret"
    sm_cli delete-secret "$TEMP_APP_WRITE" --force >/dev/null 2>&1 || true
  fi

  app_admin_output="$(run_as_client http://127.0.0.1:8081 "$APP_ACCESS_KEY" "$APP_SECRET_KEY" list-client-credentials 2>&1 || true)"
  if printf '%s' "$app_admin_output" | grep -q 'AccessDeniedException'; then
    pass "App credential cannot manage clients on the admin listener"
  else
    fail "App credential managed clients on the admin listener"
  fi

  # Prefix isolation: create a secret outside the app prefix as admin, then try
  # to read it with the app credential.
  TEMP_OUTSIDE="client/verify-$ENV_NAME-$$/db-password"
  if printf 'outside' | sm_cli create-secret "$TEMP_OUTSIDE" --stdin >/dev/null 2>&1; then
    app_outside_output="$(run_as_client http://127.0.0.1:8080 "$APP_ACCESS_KEY" "$APP_SECRET_KEY" get-secret-value "$TEMP_OUTSIDE" 2>&1 || true)"
    if printf '%s' "$app_outside_output" | grep -q 'AccessDeniedException'; then
      pass "App credential cannot read another client's prefix"
    else
      fail "App credential read a secret outside its prefix"
    fi
    sm_cli delete-secret "$TEMP_OUTSIDE" --force >/dev/null 2>&1 || true
  else
    skip "Prefix isolation check (could not create a temporary secret)"
  fi
else
  skip "App credential checks (app credential not available)"
fi

# The admin listener is container-loopback only; another container must not
# be able to reach it.
if [ -n "$APP_CONTAINER" ]; then
  if compose_sm exec -T app node -e "fetch('http://secrets-manager:8081/healthz',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))" >/dev/null 2>&1; then
    pass "Admin listener is not reachable from the app container"
  else
    fail "Admin listener is reachable from the app container"
  fi
else
  skip "Admin listener isolation check (app container not running)"
fi

if [ "$USE_SDK" = true ]; then
  note ""
  if ! has docker; then
    skip "AWS SDK v3 client (docker unavailable)"
  elif [ ! -f "$ROOT_DIR/secrets-manager/examples/aws-sdk-v3.mjs" ]; then
    skip "AWS SDK v3 client (example missing)"
  elif ! docker network inspect "${PROJECT}_default" >/dev/null 2>&1; then
    skip "AWS SDK v3 client (network ${PROJECT}_default missing)"
  else
    if ! docker image inspect node:22-bookworm >/dev/null 2>&1; then
      note "Pulling node:22-bookworm for the SDK test..."
      docker pull node:22-bookworm >/dev/null 2>&1 || true
    fi

    SDK_ENV=(
      -e AWS_ACCESS_KEY_ID
      -e AWS_SECRET_ACCESS_KEY
      -e AWS_REGION
      -e AWS_DEFAULT_REGION
      -e "SM_ENDPOINT=http://secrets-manager:8080"
      -e "SM_POLICY_SECRET_ID=$APP_CONFIG_SECRET_ID"
    )
    if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
      SDK_ENV+=(-e AWS_SESSION_TOKEN)
    fi

    note "Running @aws-sdk/client-secrets-manager in a throwaway container..."
    if docker run --rm --network "${PROJECT}_default" \
      "${SDK_ENV[@]}" \
      -v "$ROOT_DIR/secrets-manager/examples:/example:ro" \
      node:22-bookworm \
      bash -c 'set -e; mkdir -p /tmp/sdk; cd /tmp/sdk; cp /example/aws-sdk-v3.mjs .; npm init -y >/dev/null 2>&1; npm i --silent --no-audit --no-fund @aws-sdk/client-secrets-manager >/dev/null 2>&1; node aws-sdk-v3.mjs'; then
      pass "AWS SDK v3 client (ListSecrets + GetSecretValue)"
    else
      fail "AWS SDK v3 client"
    fi
  fi
else
  skip "AWS SDK v3 client (use --sdk)"
fi

if [ "$USE_BOTO3" = true ]; then
  note ""
  if ! has docker; then
    skip "boto3 client (docker unavailable)"
  elif [ ! -f "$ROOT_DIR/secrets-manager/examples/boto3_example.py" ]; then
    skip "boto3 client (example missing)"
  elif ! docker network inspect "${PROJECT}_default" >/dev/null 2>&1; then
    skip "boto3 client (network ${PROJECT}_default missing)"
  else
    if ! docker image inspect python:3-slim >/dev/null 2>&1; then
      note "Pulling python:3-slim for the boto3 test..."
      docker pull python:3-slim >/dev/null 2>&1 || true
    fi

    BOTO_ENV=(
      -e AWS_ACCESS_KEY_ID
      -e AWS_SECRET_ACCESS_KEY
      -e AWS_REGION
      -e AWS_DEFAULT_REGION
      -e "SM_ENDPOINT=http://secrets-manager:8080"
      -e "SM_POLICY_SECRET_ID=$APP_CONFIG_SECRET_ID"
      -e "APP_ENV=$ENV_NAME"
    )
    if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
      BOTO_ENV+=(-e AWS_SESSION_TOKEN)
    fi

    note "Running boto3 in a throwaway Python container..."
    if docker run --rm --network "${PROJECT}_default" \
      "${BOTO_ENV[@]}" \
      -v "$ROOT_DIR/secrets-manager/examples:/example:ro" \
      python:3-slim \
      bash -c 'pip install --quiet -r /example/requirements.txt >/dev/null 2>&1 && python /example/boto3_example.py'; then
      pass "boto3 client (ListSecrets + GetSecretValue)"
    else
      fail "boto3 client"
    fi
  fi
else
  skip "boto3 client (use --boto3)"
fi

summary
