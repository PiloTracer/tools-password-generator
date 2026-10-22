import crypto from "node:crypto";

/**
 * Compute the lowercase hex SHA-256 digest of a string or Buffer.
 * @param {string|Buffer} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string|Buffer} key
 * @param {string|Buffer} value
 * @returns {Buffer}
 */
export function hmacSha256(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

/**
 * Constant-time comparison of two hex encoded digests.
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function timingSafeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    return false;
  }
}

/**
 * RFC 3986 encoding as required by AWS Signature Version 4.
 * @param {string} value
 * @returns {string}
 */
export function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Encode every segment of a URL path for a SigV4 canonical request.
 * @param {string} pathname
 * @returns {string}
 */
export function encodePath(pathname) {
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

/**
 * @param {number} length
 * @returns {string}
 */
export function randomAlphanumeric(length = 6) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += alphabet[crypto.randomInt(alphabet.length)];
  }
  return output;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function toInteger(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    const error = new Error(`${field} is required.`);
    error.userFacing = true;
    throw error;
  }
  return value;
}

/**
 * @param {number|undefined} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function normalizeMaxResults(value, fallback, min = 1, max = 100) {
  if (value === undefined) {
    return fallback;
  }
  if (value < min || value > max) {
    const error = new Error(`MaxResults must be between ${min} and ${max}.`);
    error.userFacing = true;
    throw error;
  }
  return value;
}
