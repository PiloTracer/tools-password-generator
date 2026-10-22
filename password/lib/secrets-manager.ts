import { signAwsRequest } from "./aws-sigv4";

/**
 * Client for the AWS-compatible Secrets Manager endpoint exposed by the
 * `secrets-manager` service. It speaks the AWS JSON 1.1 protocol and signs
 * requests with SigV4 using only Node.js core modules.
 *
 * Nothing here ever logs secret material.
 */

export type SecretResult<T> =
  | { ok: true; value: T; cached: boolean }
  | { ok: false; code: string; error: string; cached: boolean };

type CacheEntry =
  | { ok: true; value: string; expiresAt: number }
  | { ok: false; code: string; error: string; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const DEFAULT_TIMEOUT_MS = 4_000;
const FAILURE_CACHE_MS = 5_000;

export function secretsManagerEnabled(): boolean {
  return (
    String(process.env.SECRETS_MANAGER_ENABLED ?? "").toLowerCase() === "true" &&
    Boolean(process.env.SECRETS_MANAGER_ENDPOINT)
  );
}

export function secretsManagerEndpoint(): string {
  return (process.env.SECRETS_MANAGER_ENDPOINT ?? "").trim().replace(/\/+$/, "");
}

export function secretsManagerRegion(): string {
  return (
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    "us-east-1"
  );
}

export function secretsManagerTtlMs(): number {
  const configured = Number.parseInt(process.env.SECRETS_CACHE_TTL_MS ?? "30000", 10);
  if (!Number.isFinite(configured)) {
    return 30_000;
  }
  return Math.min(600_000, Math.max(1_000, configured));
}

export function resetSecretsManagerCache(): void {
  cache.clear();
}

function rememberFailure(secretId: string, code: string, error: string): SecretResult<string> {
  cache.set(secretId, {
    ok: false,
    code,
    error,
    expiresAt: Date.now() + FAILURE_CACHE_MS,
  });
  return { ok: false, code, error, cached: false };
}

/**
 * Fetch a secret string from the Secrets Manager, with a short in-process
 * cache so a config change is picked up within the TTL.
 */
export async function getSecretString(
  secretId: string,
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<SecretResult<string>> {
  if (!secretId) {
    return { ok: false, code: "MissingSecretId", error: "No secret id configured.", cached: false };
  }

  const now = Date.now();
  const cached = cache.get(secretId);
  if (!options.force && cached && cached.expiresAt > now) {
    if (cached.ok) {
      return { ok: true, value: cached.value, cached: true };
    }
    return { ok: false, code: cached.code, error: cached.error, cached: true };
  }

  const endpoint = secretsManagerEndpoint();
  if (!endpoint) {
    return rememberFailure(secretId, "NotConfigured", "SECRETS_MANAGER_ENDPOINT is not set.");
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    return rememberFailure(
      secretId,
      "MissingCredentials",
      "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not configured.",
    );
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return rememberFailure(secretId, "InvalidEndpoint", "SECRETS_MANAGER_ENDPOINT is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return rememberFailure(secretId, "InvalidEndpoint", "SECRETS_MANAGER_ENDPOINT must be http(s).");
  }

  const body = JSON.stringify({ SecretId: secretId });
  const headers = signAwsRequest({
    method: "POST",
    url,
    region: secretsManagerRegion(),
    service: "secretsmanager",
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env.AWS_SESSION_TOKEN?.trim() || undefined,
    },
    body,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "secretsmanager.GetSecretValue",
    },
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await response.text();

    let payload: Record<string, unknown> = {};
    if (text.trim() !== "") {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return rememberFailure(
          secretId,
          "InvalidResponse",
          "Secrets Manager returned a non-JSON response.",
        );
      }
    }

    if (!response.ok) {
      const code =
        typeof payload.__type === "string" ? payload.__type : `HTTP_${response.status}`;
      const message =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.Message === "string"
            ? payload.Message
            : `Secrets Manager returned HTTP ${response.status}.`;
      return rememberFailure(secretId, code, message);
    }

    const value = payload.SecretString;
    if (typeof value !== "string") {
      return rememberFailure(
        secretId,
        "BinarySecret",
        "The secret does not contain a string value.",
      );
    }

    cache.set(secretId, {
      ok: true,
      value,
      expiresAt: Date.now() + secretsManagerTtlMs(),
    });
    return { ok: true, value, cached: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Secrets Manager error.";
    return rememberFailure(secretId, "RequestFailed", message);
  }
}

/**
 * Fetch a secret and parse its JSON payload.
 */
export async function getSecretJson<T>(
  secretId: string,
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<SecretResult<T>> {
  const result = await getSecretString(secretId, options);
  if (!result.ok) {
    return result;
  }
  try {
    return { ok: true, value: JSON.parse(result.value) as T, cached: result.cached };
  } catch {
    return {
      ok: false,
      code: "InvalidSecretJson",
      error: "The secret is not valid JSON.",
      cached: result.cached,
    };
  }
}
