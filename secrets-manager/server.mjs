import crypto from "node:crypto";
import http from "node:http";

import {
  AwsError,
  internalError,
  invalidRequest,
  serializationError,
  unknownOperation,
} from "./lib/errors.mjs";
import { createLogger } from "./lib/logger.mjs";
import { dispatch, SUPPORTED_OPERATIONS } from "./lib/operations.mjs";
import { signRequest, verifyRequest } from "./lib/sigv4.mjs";
import { SecretStore } from "./lib/store.mjs";

const VERSION = "1.0.0";
const MAX_BODY_BYTES = 1024 * 1024;

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

  const port = Number.parseInt(env.SM_PORT || "8080", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SM_PORT must be a valid TCP port.");
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
    region,
    accountId,
    accessKeyId,
    secretAccessKey,
    sessionToken,
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
        reject(error);
        req.destroy();
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
  async function handle(req, res) {
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
        return sendJson(
          res,
          health.ok ? 200 : 503,
          { status: health.ok ? "ready" : "not_ready", ...health },
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
            operations: SUPPORTED_OPERATIONS,
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

      if (config.requireAuth) {
        const verification = verifyRequest({
          method: req.method,
          url,
          headers: req.headers,
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
        if (!verification.ok) {
          throw verification.error;
        }
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

      const result = dispatch(operation, payload, store);
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

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
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

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;

  server.listen(config.port, config.host, () => {
    logger.info("secrets manager listening", {
      version: VERSION,
      host: config.host,
      port: config.port,
      region: config.region,
      accountId: config.accountId,
      authRequired: config.requireAuth,
      dataDir: config.dataDir,
      secrets: store.health().secrets,
    });
  });

  function shutdown(signal) {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
