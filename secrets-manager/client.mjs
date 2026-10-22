import { signRequest } from "./lib/sigv4.mjs";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8080";
const DEFAULT_REGION = "us-east-1";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveEndpoint(env = process.env) {
  const endpoint =
    env.SM_ENDPOINT ||
    env.AWS_ENDPOINT_URL_SECRETSMANAGER ||
    env.AWS_ENDPOINT_URL ||
    DEFAULT_ENDPOINT;
  return endpoint.replace(/\/+$/, "");
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{accessKeyId: string, secretAccessKey: string, sessionToken: string, region: string}}
 */
export function resolveCredentials(env = process.env) {
  return {
    accessKeyId: env.SM_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: env.SM_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || "",
    sessionToken: env.SM_SESSION_TOKEN || env.AWS_SESSION_TOKEN || "",
    region: env.SM_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || DEFAULT_REGION,
  };
}

/**
 * Call an AWS Secrets Manager operation using the AWS JSON 1.1 protocol.
 *
 * @param {string} operation
 * @param {Record<string, unknown>} [payload]
 * @param {{endpoint?: string, region?: string, credentials?: Record<string, string>, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function call(operation, payload = {}, options = {}) {
  const env = options.env || process.env;
  const endpoint = options.endpoint || resolveEndpoint(env);
  const environmentCredentials = resolveCredentials(env);
  const credentials = {
    ...environmentCredentials,
    ...(options.credentials || {}),
  };
  const region = options.region || credentials.region;

  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Error(
      "Missing SigV4 credentials. Set SM_ACCESS_KEY_ID/SM_SECRET_ACCESS_KEY or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.",
    );
  }

  const url = new URL(endpoint);
  const body = JSON.stringify(payload);
  const headers = signRequest({
    method: "POST",
    url,
    region,
    service: "secretsmanager",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken || undefined,
    body,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `secretsmanager.${operation}`,
    },
  });

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
  });
  const text = await response.text();

  let data = {};
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    const error = new Error(
      data.message || data.Message || `Secrets Manager request failed with HTTP ${response.status}.`,
    );
    error.code = data.__type || data.code || "UnknownError";
    error.status = response.status;
    throw error;
  }

  return data;
}
