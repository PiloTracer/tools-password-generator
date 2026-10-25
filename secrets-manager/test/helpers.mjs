/**
 * Contract-test harness for the secrets-manager wire contract SPEC
 * (`.work/features/secrets-manager/20261025-SPEC.md`).
 *
 * Design rules:
 *  - The SigV4 signer here is an INDEPENDENT implementation. It must not import
 *    `../lib/sigv4.mjs`, otherwise a shared canonicalization bug would make the
 *    signer and verifier agree and the test would prove nothing.
 *  - The service is exercised over real HTTP against a spawned child process,
 *    because the deployed artifact is a process, not a module.
 *  - Point SM_SERVER_ENTRY at a pristine checkout of the deployed commit to run
 *    the same assertions against the production baseline.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SERVICE_ENTRY = process.env.SM_SERVER_ENTRY
  ? path.resolve(process.env.SM_SERVER_ENTRY)
  : path.resolve(HERE, "..", "server.mjs");

export const REGION = "us-east-1";
export const ACCOUNT_ID = "123456789012";

/** Fixed 32-byte key so the run is deterministic (64 hex chars). */
export const MASTER_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

export const ADMIN = { accessKeyId: "AKIAADMINADMIN0001", secretAccessKey: "admin-secret-key" };
export const GEN = { accessKeyId: "AKIAGENERATOR00001", secretAccessKey: "generator-secret-key" };
export const ACB = { accessKeyId: "AKIAACBCLIENT00001", secretAccessKey: "acb-secret-key" };

export const GEN_PREFIX = "password-generator/dev/";
export const ACB_PREFIX = "client/acb/";

// ---------------------------------------------------------------------------
// Independent SigV4 signer
// ---------------------------------------------------------------------------

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function normalizeValue(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

/** ISO-8601 basic format, e.g. 20261025T193000Z. */
export function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Sign a request per AWS Signature Version 4.
 * @returns {Record<string,string>} lowercase headers, including `authorization`
 */
export function signV4({
  method,
  url,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  body = "",
  headers = {},
  now = new Date(),
  region = REGION,
  service = "secretsmanager",
}) {
  const target = url instanceof URL ? url : new URL(url);
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body).toString("hex");

  /** @type {Record<string,string>} */
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = String(value);
  }
  normalized.host = target.host;
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
    .map((name) => `${name}:${normalizeValue(normalized[name])}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  // No query parameters are used by this API; keep the slot empty on purpose.
  const canonicalRequest = [
    method.toUpperCase(),
    target.pathname || "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest).toString("hex"),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  normalized.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return normalized;
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

function repoRoot() {
  return path.resolve(HERE, "..", "..");
}

function scratchDir(tag) {
  const base = path.join(repoRoot(), "tmp", "contract-tests");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${tag}-`));
}

/** Allocate a fresh data directory (used to share one across a restart). */
export function newDataDir(tag = "data") {
  return scratchDir(tag);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no port assigned"))));
    });
  });
}

export function baseEnv(dataDir) {
  return {
    SM_HOST: "127.0.0.1",
    SM_DATA_DIR: dataDir,
    SM_REGION: REGION,
    SM_ACCOUNT_ID: ACCOUNT_ID,
    SM_REQUIRE_AUTH: "true",
    SM_LOG_LEVEL: "error",
    SM_MASTER_KEY: MASTER_KEY_HEX,
    SM_ACCESS_KEY_ID: ADMIN.accessKeyId,
    SM_SECRET_ACCESS_KEY: ADMIN.secretAccessKey,
    SM_CLIENTS_JSON: JSON.stringify([
      {
        accessKeyId: GEN.accessKeyId,
        secretAccessKey: GEN.secretAccessKey,
        name: "password-generator",
        description: "password generator app",
        allowedPrefixes: [GEN_PREFIX],
      },
      {
        accessKeyId: ACB.accessKeyId,
        secretAccessKey: ACB.secretAccessKey,
        name: "acb",
        description: "ACB integration",
        allowedPrefixes: [ACB_PREFIX],
      },
    ]),
  };
}

/**
 * Spawn the service and wait until /healthz answers.
 * @param {{env?: Record<string,string>, dataDir?: string, tag?: string}} [options]
 */
export async function startService(options = {}) {
  const dataDir = options.dataDir || scratchDir(options.tag || "run");
  const port = await freePort();
  // The hardened build binds a second, loopback-only listener. It is an env
  // no-op on the baseline, so it is always allocated to keep every instance
  // isolated — two instances on one host collide on the default 8081.
  const adminPort = options.adminPort || (await freePort());
  const env = {
    ...process.env,
    ...baseEnv(dataDir),
    ...(options.env || {}),
    SM_PORT: String(port),
    SM_ADMIN_HOST: "127.0.0.1",
    SM_ADMIN_PORT: String(adminPort),
  };

  const child = spawn(process.execPath, [SERVICE_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`service exited early (code ${child.exitCode}):\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) {
        break;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`service did not become healthy within 10s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const stop = async () => {
    if (child.exitCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  };

  const adminUrl = `http://127.0.0.1:${adminPort}`;

  /** Does the public listener still expose administrative operations? */
  const detectMode = async () => {
    const { data } = await getJson(baseUrl, "/");
    const operations = Array.isArray(data.operations) ? data.operations : [];
    return operations.includes("ListClientCredentials") ? "public-admin" : "admin-listener";
  };

  const mode = await detectMode();
  if (mode === "admin-listener") {
    const deadlineAdmin = Date.now() + 5000;
    for (;;) {
      try {
        const response = await fetch(`${adminUrl}/healthz`);
        if (response.status === 200) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadlineAdmin) {
        child.kill("SIGKILL");
        throw new Error(`admin listener did not become healthy:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  return {
    baseUrl,
    adminUrl,
    mode,
    dataDir,
    port,
    adminPort,
    child,
    stop,
    output: () => output,
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * Sign and send one operation.
 *
 * `options.mutate` receives the signed headers so a test can corrupt exactly one
 * aspect (signature, date, content hash) while everything else stays valid.
 */
export async function call(baseUrl, credentials, operation, payload = {}, options = {}) {
  const url = new URL(baseUrl);
  const body = options.rawBody !== undefined ? options.rawBody : JSON.stringify(payload);
  const headers = signV4({
    method: "POST",
    url,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    body,
    now: options.now,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": options.target || `secretsmanager.${operation}`,
    },
  });

  if (options.mutate) {
    options.mutate(headers);
  }

  // `host` is a forbidden header in fetch; the client sets it from the URL, and
  // it matches the value that was signed.
  const { host, ...sendable } = headers;

  const response = await fetch(url, { method: "POST", headers: sendable, body });
  const text = await response.text();
  let data = {};
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text, raw: true };
    }
  }
  return { status: response.status, data, headers: response.headers, sentHost: host };
}

/** Sign and send a bare request, for negative tests that need full control. */
export async function rawPost(baseUrl, headers, body) {
  const response = await fetch(new URL(baseUrl), { method: "POST", headers, body });
  const text = await response.text();
  let data = {};
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch {
    data = { message: text, raw: true };
  }
  return { status: response.status, data, headers: response.headers };
}

export async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const text = await response.text();
  let data = {};
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch {
    data = { message: text, raw: true };
  }
  return { status: response.status, data, headers: response.headers };
}

export function sortKeys(object) {
  return Object.keys(object).sort();
}
