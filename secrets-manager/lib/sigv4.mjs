import crypto from "node:crypto";

import {
  encodePath,
  encodeRfc3986,
  hmacSha256,
  sha256Hex,
  timingSafeEqualHex,
} from "./util.mjs";
import {
  invalidSignature,
  missingAuthenticationToken,
  requestExpired,
  unrecognizedClient,
  xAmzContentSha256Mismatch,
} from "./errors.mjs";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "secretsmanager";
const TERMINATOR = "aws4_request";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/**
 * @param {string|undefined} value
 * @returns {string}
 */
function normalizeHeaderValue(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

/**
 * @param {URLSearchParams} searchParams
 * @returns {string}
 */
function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  }
  pairs.sort((a, b) => {
    if (a[0] === b[0]) {
      return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    }
    return a[0] < b[0] ? -1 : 1;
  });
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

/**
 * @param {Date} date
 * @returns {string}
 */
function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * @param {string} secretAccessKey
 * @param {string} dateStamp
 * @param {string} region
 * @param {string} service
 * @returns {Buffer}
 */
function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, service);
  return hmacSha256(serviceKey, TERMINATOR);
}

/**
 * Sign a request using AWS Signature Version 4.
 *
 * @param {{
 *   method: string,
 *   url: URL|string,
 *   region: string,
 *   service?: string,
 *   accessKeyId: string,
 *   secretAccessKey: string,
 *   sessionToken?: string,
 *   body?: string,
 *   headers?: Record<string, string>,
 *   now?: Date,
 * }} options
 * @returns {Record<string, string>} lowercase headers including authorization
 */
export function signRequest(options) {
  const {
    method,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    body = "",
    headers = {},
    now = new Date(),
    service = SERVICE,
  } = options;
  const url = options.url instanceof URL ? options.url : new URL(options.url);
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  /** @type {Record<string, string>} */
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = String(value);
  }
  normalized.host = url.host;
  normalized["x-amz-date"] = amzDate;
  normalized["x-amz-content-sha256"] = payloadHash;
  if (!normalized["content-type"]) {
    normalized["content-type"] = "application/x-amz-json-1.1";
  }
  if (sessionToken) {
    normalized["x-amz-security-token"] = sessionToken;
  }

  const signedHeaderNames = Object.keys(normalized).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${normalizeHeaderValue(normalized[name])}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    encodePath(url.pathname || "/"),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/${TERMINATOR}`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  normalized.authorization =
    `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return normalized;
}

/**
 * @typedef {{
 *   accessKeyId: string,
 *   secretAccessKey: string,
 *   sessionToken?: string,
 *   region: string,
 *   service?: string,
 *   maxClockSkewMs?: number,
 * }} VerifyConfig
 */

/**
 * Verify the AWS Signature Version 4 of an incoming request.
 *
 * @param {{
 *   method: string,
 *   url: URL,
 *   headers: Record<string, string|string[]|undefined>,
 *   body?: string,
 *   config: VerifyConfig,
 *   now?: number,
 * }} options
 * @returns {{ok: true}|{ok: false, error: import("./errors.mjs").AwsError}}
 */
export function verifyRequest(options) {
  const { method, url, body = "", config, now = Date.now() } = options;
  const service = config.service || SERVICE;

  /** @type {Record<string, string>} */
  const headers = {};
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (value === undefined) {
      continue;
    }
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
  }

  const authorization = headers.authorization;
  if (!authorization) {
    return { ok: false, error: missingAuthenticationToken() };
  }

  const match = /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-fA-F]{64})$/.exec(
    authorization.trim(),
  );
  if (!match) {
    return { ok: false, error: invalidSignature() };
  }

  const [, credential, signedHeadersValue, providedSignature] = match;
  const credentialParts = credential.split("/");
  if (credentialParts.length !== 5) {
    return { ok: false, error: invalidSignature("The credential scope is malformed.") };
  }
  const [accessKeyId, dateStamp, region, credentialService, terminator] = credentialParts;

  if (accessKeyId !== config.accessKeyId) {
    return { ok: false, error: unrecognizedClient() };
  }
  if (credentialService !== service) {
    return { ok: false, error: invalidSignature() };
  }
  if (terminator !== TERMINATOR) {
    return { ok: false, error: invalidSignature() };
  }
  if (region !== config.region) {
    return {
      ok: false,
      error: invalidSignature(
        `Credential should be scoped to a valid region, not '${region}'.`,
      ),
    };
  }

  const amzDate = headers["x-amz-date"];
  if (!amzDate || !/^\d{8}T\d{6}Z$/.test(amzDate)) {
    return { ok: false, error: invalidSignature("The x-amz-date header is missing or malformed.") };
  }
  if (amzDate.slice(0, 8) !== dateStamp) {
    return { ok: false, error: invalidSignature() };
  }

  const requestTime = Date.UTC(
    Number(amzDate.slice(0, 4)),
    Number(amzDate.slice(4, 6)) - 1,
    Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)),
    Number(amzDate.slice(11, 13)),
    Number(amzDate.slice(13, 15)),
  );
  if (!Number.isFinite(requestTime)) {
    return { ok: false, error: invalidSignature() };
  }
  const maxSkewMs = config.maxClockSkewMs ?? 15 * 60 * 1000;
  if (Math.abs(now - requestTime) > maxSkewMs) {
    return { ok: false, error: requestExpired() };
  }

  if (config.sessionToken && headers["x-amz-security-token"] !== config.sessionToken) {
    return { ok: false, error: unrecognizedClient() };
  }

  const signedHeaderNames = signedHeadersValue.split(";");
  if (signedHeaderNames.length === 0 || !signedHeaderNames.includes("host")) {
    return { ok: false, error: invalidSignature("The host header must be signed.") };
  }

  let canonicalHeaders = "";
  for (const name of signedHeaderNames) {
    const value = headers[name];
    if (value === undefined) {
      return {
        ok: false,
        error: invalidSignature(`The signed header '${name}' is missing from the request.`),
      };
    }
    canonicalHeaders += `${name}:${normalizeHeaderValue(value)}\n`;
  }

  const computedPayloadHash = sha256Hex(body);
  const declaredPayloadHash = headers["x-amz-content-sha256"];
  const payloadHash =
    !declaredPayloadHash || declaredPayloadHash === UNSIGNED_PAYLOAD
      ? computedPayloadHash
      : declaredPayloadHash;

  if (
    declaredPayloadHash &&
    declaredPayloadHash !== UNSIGNED_PAYLOAD &&
    declaredPayloadHash !== computedPayloadHash
  ) {
    return { ok: false, error: xAmzContentSha256Mismatch() };
  }

  const canonicalRequest = [
    method.toUpperCase(),
    encodePath(url.pathname || "/"),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeadersValue,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/${TERMINATOR}`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey(config.secretAccessKey, dateStamp, region, service);
  const expectedSignature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  if (!timingSafeEqualHex(expectedSignature, providedSignature)) {
    return { ok: false, error: invalidSignature() };
  }

  return { ok: true };
}
