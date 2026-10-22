import crypto from "node:crypto";

export type AwsSigV4Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type AwsSigV4Options = {
  method: string;
  url: URL;
  region: string;
  service?: string;
  credentials: AwsSigV4Credentials;
  body?: string;
  headers?: Record<string, string>;
  now?: Date;
};

const ALGORITHM = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key: crypto.BinaryLike, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(pathname: string): string {
  if (!pathname) {
    return "/";
  }
  return pathname
    .split("/")
    .map((segment) => {
      try {
        return encodeRfc3986(decodeURIComponent(segment));
      } catch {
        return encodeRfc3986(segment);
      }
    })
    .join("/");
}

function canonicalQuery(searchParams: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  }
  pairs.sort((left, right) => {
    if (left[0] === right[0]) {
      return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
    }
    return left[0] < right[0] ? -1 : 1;
  });
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Sign an HTTP request with AWS Signature Version 4.
 *
 * The returned object contains lowercase header names. It includes `host`,
 * which browsers/undici manage themselves, but whose value always matches the
 * URL host, so the signature remains valid.
 */
export function signAwsRequest(options: AwsSigV4Options): Record<string, string> {
  const {
    method,
    url,
    region,
    credentials,
    body = "",
    headers = {},
    now = new Date(),
    service = "secretsmanager",
  } = options;

  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  normalized.host = url.host;
  normalized["x-amz-date"] = amzDate;
  normalized["x-amz-content-sha256"] = payloadHash;
  if (!normalized["content-type"]) {
    normalized["content-type"] = "application/x-amz-json-1.1";
  }
  if (credentials.sessionToken) {
    normalized["x-amz-security-token"] = credentials.sessionToken;
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
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, TERMINATOR);
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  normalized.authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return normalized;
}

export { UNSIGNED_PAYLOAD };
