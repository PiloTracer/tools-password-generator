import crypto from "node:crypto";
import http from "node:http";

import {
  AwsError,
  accessDenied,
  internalError,
  invalidRequest,
  serializationError,
  unknownOperation,
} from "./lib/errors.mjs";
import { createLogger } from "./lib/logger.mjs";
import { dispatch, SUPPORTED_OPERATIONS } from "./lib/operations.mjs";
import { signRequest, verifyRequest } from "./lib/sigv4.mjs";
import { SecretStore } from "./lib/store.mjs";

const VERSION = "1.1.0";
const MAX_BODY_BYTES = 1024 * 1024;

const CLIENT_CREDENTIAL_OPERATIONS = new Set([
  "CreateClientCredential",
  "DeleteClientCredential",
  "GetClientCredential",
  "ListClientCredentials",
]);

function isClientCredentialOperation(operation) {
  return CLIENT_CREDENTIAL_OPERATIONS.has(operation);
}
const MAX_CLIENT_DESCRIPTION_LENGTH = 512;

/**
 * Parse the optional per-client SigV4 credentials.
 *
 * The primary SM_ACCESS_KEY_ID remains the full-access instance credential.
 * Client credentials are restricted by name prefix in operations.mjs.
 *
 * @param {string|undefined} raw
 * @param {string} primaryAccessKeyId
 */
function parseClientCredentials(raw, primaryAccessKeyId) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("SM_CLIENTS_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SM_CLIENTS_JSON must be a JSON array.");
  }

  const seen = new Set(primaryAccessKeyId ? [primaryAccessKeyId] : []);
  const names = new Set();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`SM_CLIENTS_JSON[${index}] must be an object.`);
    }
    const accessKeyId = String(entry.accessKeyId || "").trim();
    const secretAccessKey = String(entry.secretAccessKey || "").trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        `SM_CLIENTS_JSON[${index}] requires accessKeyId and secretAccessKey.`,
      );
    }
    if (seen.has(accessKeyId)) {
      throw new Error(`SM_CLIENTS_JSON contains a duplicate accessKeyId: ${accessKeyId}`);
    }
    seen.add(accessKeyId);

    const sessionToken = String(entry.sessionToken || "").trim();
    const name = String(entry.name || accessKeyId).trim();
    if (!name) {
      throw new Error(`SM_CLIENTS_JSON[${index}] has an empty name.`);
    }
    if (names.has(name)) {
      throw new Error(`SM_CLIENTS_JSON contains a duplicate client name: ${name}`);
    }
    names.add(name);
    const description = String(entry.description || "").trim();
    if (description.length > MAX_CLIENT_DESCRIPTION_LENGTH) {
      throw new Error(
        `SM_CLIENTS_JSON[${index}] description must be ${MAX_CLIENT_DESCRIPTION_LENGTH} characters or fewer.`,
      );
    }
    const rawPrefixes = entry.allowedPrefixes;
    if (!Array.isArray(rawPrefixes) || rawPrefixes.length === 0) {
      throw new Error(
        `SM_CLIENTS_JSON[${index}] requires at least one allowedPrefixes entry.`,
      );
    }
    const allowedPrefixes = [];
    for (const rawPrefix of rawPrefixes) {
      let prefix = String(rawPrefix || "").trim();
      if (!prefix) {
        throw new Error(`SM_CLIENTS_JSON[${index}] has an empty allowedPrefixes entry.`);
      }
      if (!prefix.endsWith("/")) {
        prefix += "/";
      }
      if (!allowedPrefixes.includes(prefix)) {
        allowedPrefixes.push(prefix);
      }
    }

    const readOnly =
      entry.readOnly === true ||
      String(entry.readOnly || "").trim().toLowerCase() === "true";

    return {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      name,
      description,
      admin: false,
      readOnly,
      allowedPrefixes,
    };
  });
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function loadConfig(env) {
  const requireAuth = !["false", "0", "no", "off"].includes(
    String(env.SM_REQUIRE_AUTH ?? "true").trim().toLowerCase(),
  );

  const accessKeyId = String(env.SM_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(
    env.SM_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || "",
  ).trim();
  const sessionToken = String(env.SM_SESSION_TOKEN || env.AWS_SESSION_TOKEN || "").trim();

  if (requireAuth && (!accessKeyId || !secretAccessKey)) {
    throw new Error(
      "SM_ACCESS_KEY_ID and SM_SECRET_ACCESS_KEY are required when SM_REQUIRE_AUTH is enabled.",
    );
  }

  const clients = parseClientCredentials(env.SM_CLIENTS_JSON, accessKeyId);
  const principals = [
    ...(accessKeyId && secretAccessKey
      ? [{
          accessKeyId,
          secretAccessKey,
          sessionToken,
          name: "instance-admin",
          admin: true,
          readOnly: false,
          allowedPrefixes: [],
        }]
      : []),
    ...clients,
  ];

  const port = Number.parseInt(env.SM_PORT || "8080", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SM_PORT must be a valid TCP port.");
  }

  const adminHost = String(env.SM_ADMIN_HOST || "127.0.0.1").trim();
  if (!["127.0.0.1", "::1", "localhost"].includes(adminHost)) {
    throw new Error("SM_ADMIN_HOST must be a loopback address (127.0.0.1, ::1 or localhost).");
  }

  const adminPort = Number.parseInt(env.SM_ADMIN_PORT || "8081", 10);
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) {
    throw new Error("SM_ADMIN_PORT must be a valid TCP port.");
  }
  if (adminPort === port) {
    throw new Error("SM_ADMIN_PORT must differ from SM_PORT.");
  }

  const region = String(env.SM_REGION || env.AWS_REGION || "us-east-1").trim();
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    throw new Error(`SM_REGION is invalid: ${region}`);
  }

  const accountId = String(env.SM_ACCOUNT_ID || "000000000000").trim();
  if (!/^\d{12}$/.test(accountId)) {
    throw new Error("SM_ACCOUNT_ID must be a 12 digit string.");
  }

  const maxSecretBytes = Number.parseInt(env.SM_MAX_SECRET_BYTES || "65536", 10);
  if (!Number.isInteger(maxSecretBytes) || maxSecretBytes < 1) {
    throw new Error("SM_MAX_SECRET_BYTES must be a positive integer.");
  }

  const recoveryWindowDays = Number.parseInt(env.SM_RECOVERY_WINDOW_DAYS || "30", 10);
  if (!Number.isInteger(recoveryWindowDays) || recoveryWindowDays < 7 || recoveryWindowDays > 30) {
    throw new Error("SM_RECOVERY_WINDOW_DAYS must be between 7 and 30.");
  }

  const maxClockSkewSeconds = Number.parseInt(env.SM_MAX_CLOCK_SKEW_SECONDS || "900", 10);
  if (!Number.isInteger(maxClockSkewSeconds) || maxClockSkewSeconds < 1) {
    throw new Error("SM_MAX_CLOCK_SKEW_SECONDS must be a positive integer.");
  }

  return {
    port,
    host: env.SM_HOST || "0.0.0.0",
    adminHost,
    adminPort,
    region,
    accountId,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    principals,
    clients,
    requireAuth,
    masterKey: env.SM_MASTER_KEY || "",
    dataDir: env.SM_DATA_DIR || "/data",
    logLevel: env.SM_LOG_LEVEL || "info",
    maxSecretBytes: Math.min(maxSecretBytes, 65536),
    recoveryWindowDays,
    maxClockSkewMs: maxClockSkewSeconds * 1000,
    service: "secretsmanager",
  };
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 * @param {string} [contentType]
 */
function sendJson(res, status, payload, headers = {}, contentType = "application/x-amz-json-1.1") {
  if (res.headersSent) {
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

/**
 * @param {http.ServerResponse} res
 * @param {unknown} error
 * @param {string} requestId
 * @param {{error: Function}} logger
 */
function sendError(res, error, requestId, logger) {
  const awsError = error instanceof AwsError ? error : internalError();
  if (!(error instanceof AwsError)) {
    logger.error("unexpected error", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  sendJson(
    res,
    awsError.status,
    { __type: awsError.type, message: awsError.message },
    {
      "x-amzn-RequestId": requestId,
      "x-amzn-ErrorType": awsError.type,
    },
  );
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        const error = new AwsError(
          "InvalidParameterException",
          "The request body is too large.",
          413,
        );
        // Drain instead of destroying the socket. `req.destroy()` raced the
        // error response, so callers observed ECONNRESET rather than the
        // intended HTTP 413 (contract defect D1).
        req.resume();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

/**
 * Prove at boot that the signer and the verifier agree, so an operator finds
 * credential mistakes immediately instead of on the first real request.
 *
 * @param {ReturnType<typeof loadConfig>} config
 */
function selfTestSigning(config) {
  if (!config.requireAuth) {
    return;
  }
  const url = new URL(`http://127.0.0.1:${config.port}/`);
  const body = JSON.stringify({ MaxResults: 1 });
  const headers = signRequest({
    method: "POST",
    url,
    region: config.region,
    service: config.service,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken || undefined,
    body,
    headers: {
      "x-amz-target": "secretsmanager.ListSecrets",
      "content-type": "application/x-amz-json-1.1",
    },
  });
  const result = verifyRequest({
    method: "POST",
    url,
    headers,
    body,
    config: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      region: config.region,
      service: config.service,
      maxClockSkewMs: config.maxClockSkewMs,
    },
  });
  if (!result.ok) {
    throw new Error(`SigV4 self-test failed: ${result.error.message}`);
  }
}

function main() {
  let config;
  try {
    config = loadConfig(process.env);
    selfTestSigning(config);
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        service: "secrets-manager",
        msg: "invalid configuration",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);

  let store;
  try {
    store = new SecretStore({
      dataDir: config.dataDir,
      region: config.region,
      accountId: config.accountId,
      masterKey: config.masterKey,
      maxSecretBytes: config.maxSecretBytes,
      recoveryWindowDays: config.recoveryWindowDays,
      logger,
      staticClients: config.clients,
      reservedAccessKeyIds: config.accessKeyId ? [config.accessKeyId] : [],
    }).init();
  } catch (error) {
    logger.error("unable to initialise the secret store", {
      dataDir: config.dataDir,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (!config.requireAuth) {
    logger.warn("SM_REQUIRE_AUTH is disabled: requests will not be signature verified");
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res, isAdminListener = false) {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(
          res,
          200,
          {
            status: "ok",
            service: "secrets-manager",
            version: VERSION,
            authRequired: config.requireAuth,
            time: new Date().toISOString(),
          },
          { "x-amzn-RequestId": requestId },
          "application/json",
        );
      }

      if (req.method === "GET" && url.pathname === "/readyz") {
        const health = store.health();
        // The public readiness probe answers "can I serve traffic?" only.
        // Secret counts, the data directory and the master-key source are
        // operational internals: keep them on the loopback admin listener so an
        // unauthenticated internet caller cannot fingerprint the store
        // (feedback F-06). HTTP status semantics are unchanged (BC6).
        const payload = isAdminListener
          ? { status: health.ok ? "ready" : "not_ready", ...health }
          : { status: health.ok ? "ready" : "not_ready", ok: health.ok, version: VERSION };
        return sendJson(
          res,
          health.ok ? 200 : 503,
          payload,
          { "x-amzn-RequestId": requestId },
          "application/json",
        );
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/info")) {
        return sendJson(
          res,
          200,
          {
            service: "secrets-manager",
            description: "AWS Secrets Manager compatible endpoint",
            protocol: "aws-json-1.1",
            version: VERSION,
            region: config.region,
            authRequired: config.requireAuth,
            operations: isAdminListener
              ? SUPPORTED_OPERATIONS
              : SUPPORTED_OPERATIONS.filter((op) => !isClientCredentialOperation(op)),
            health: ["/healthz", "/readyz"],
          },
          { "x-amzn-RequestId": requestId },
          "application/json",
        );
      }

      if (url.pathname !== "/") {
        throw invalidRequest(`Unknown path: ${url.pathname}`);
      }
      if (req.method !== "POST") {
        throw invalidRequest("Only POST requests are supported for the Secrets Manager API.");
      }

      const body = await readBody(req);

      let principal = {
        accessKeyId: "anonymous",
        name: "anonymous",
        admin: true,
        allowedPrefixes: [],
      };
      if (config.requireAuth) {
        const verification = verifyRequest({
          method: req.method,
          url,
          headers: req.headers,
          body,
          config: {
            credentials: [...config.principals, ...store.authPrincipals()],
            region: config.region,
            service: config.service,
            maxClockSkewMs: config.maxClockSkewMs,
          },
        });
        if (!verification.ok) {
          throw verification.error;
        }
        principal = verification.principal;
      }

      let payload = {};
      if (body.trim() !== "") {
        try {
          payload = JSON.parse(body);
        } catch {
          throw serializationError();
        }
      }

      const target = req.headers["x-amz-target"];
      if (typeof target !== "string" || target.length === 0) {
        throw unknownOperation("");
      }
      const separator = target.indexOf(".");
      const targetService = separator >= 0 ? target.slice(0, separator) : "";
      const operation = separator >= 0 ? target.slice(separator + 1) : target;
      if (targetService !== "secretsmanager") {
        throw unknownOperation(target);
      }

      if (!isAdminListener && isClientCredentialOperation(operation)) {
        throw accessDenied(
          "Client credential management is only available on the local admin listener.",
        );
      }

      const result = dispatch(operation, payload, store, principal);
      logger.debug("request completed", {
        requestId,
        operation,
        status: 200,
        ms: Date.now() - started,
      });
      return sendJson(res, 200, result, { "x-amzn-RequestId": requestId });
    } catch (error) {
      if (error instanceof AwsError) {
        logger.warn("request failed", {
          requestId,
          method: req.method,
          path: url.pathname,
          code: error.type,
          status: error.status,
        });
        return sendError(res, error, requestId, logger);
      }
      logger.error("unhandled request error", {
        requestId,
        method: req.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return sendError(res, internalError(), requestId, logger);
    }
  }

  function createServer(isAdminListener) {
    const instance = http.createServer((req, res) => {
      handle(req, res, isAdminListener).catch((error) => {
        logger.error("fatal handler error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          sendJson(res, 500, { __type: "InternalServiceError", message: "Internal error." });
        } else {
          res.end();
        }
      });
    });
    instance.keepAliveTimeout = 65000;
    instance.headersTimeout = 66000;
    instance.requestTimeout = 30000;
    return instance;
  }

  const server = createServer(false);
  const adminServer = createServer(true);

  /**
   * Fail fast with an actionable log entry rather than crashing with an
   * unhandled 'error' event when a listener cannot bind.
   *
   * @param {string} listener
   */
  function listenerError(listener) {
    return (error) => {
      logger.error("listener failed", {
        listener,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    };
  }
  server.on("error", listenerError("public"));
  adminServer.on("error", listenerError("admin"));

  server.listen(config.port, config.host, () => {
    logger.info("secrets manager listening", {
      version: VERSION,
      host: config.host,
      port: config.port,
      region: config.region,
      accountId: config.accountId,
      authRequired: config.requireAuth,
      clientCredentials: config.clients.length + store.managedClientCount(),
      dataDir: config.dataDir,
      secrets: store.health().secrets,
    });
  });

  adminServer.listen(config.adminPort, config.adminHost, () => {
    logger.info("secrets manager admin listener listening", {
      version: VERSION,
      host: config.adminHost,
      port: config.adminPort,
      region: config.region,
      adminOnly: true,
    });
  });

  function shutdown(signal) {
    logger.info("shutting down", { signal });
    server.close(() => {
      adminServer.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
