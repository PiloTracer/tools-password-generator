#!/usr/bin/env node
/**
 * Idempotent bootstrap for the application secrets.
 *
 * `./bin/start.sh` runs this after the Secrets Manager is healthy and before
 * the app starts. Existing secrets are left untouched unless SEED_FORCE=true,
 * so operator edits and rotations survive restarts.
 *
 * Environment:
 *   SEED_ENV        dev | prd (required)
 *   SEED_WORDLIST   path to the word list (default /seed/eff_short_wordlist_1.txt)
 *   SEED_FORCE      "true" to overwrite existing secrets
 *   SEED_PREFIX     secret name prefix (default password-generator/<env>)
 *   SM_ENDPOINT / SM_ACCESS_KEY_ID / SM_SECRET_ACCESS_KEY / SM_REGION
 */
import crypto from "node:crypto";
import fs from "node:fs";

import { call, resolveCredentials, resolveEndpoint } from "./client.mjs";

/**
 * @param {string} message
 */
function info(message) {
  process.stdout.write(`${message}\n`);
}

async function main() {
  const environment = String(process.env.SEED_ENV || "").trim();
  if (!["dev", "prd"].includes(environment)) {
    throw new Error("SEED_ENV must be 'dev' or 'prd'.");
  }

  const force = String(process.env.SEED_FORCE || "").trim().toLowerCase() === "true";
  const prefix = String(
    process.env.SEED_PREFIX || `password-generator/${environment}`,
  ).replace(/\/+$/, "");
  const wordlistPath =
    process.env.SEED_WORDLIST || "/seed/eff_short_wordlist_1.txt";

  if (!fs.existsSync(wordlistPath)) {
    throw new Error(`Word list not found: ${wordlistPath}`);
  }

  const wordlistBytes = fs.readFileSync(wordlistPath);
  if (wordlistBytes.length === 0) {
    throw new Error(`Word list is empty: ${wordlistPath}`);
  }
  const wordlistSha256 = crypto.createHash("sha256").update(wordlistBytes).digest("hex");

  // Seeded throttle: prd matches the app default and sits below the edge limit
  // (20 r/m + burst 10), so the edge is the first line and this is the backstop.
  // dev is looser to keep local iteration and smoke runs frictionless.
  const rateLimit = environment === "prd" ? 30 : 120;
  const now = new Date().toISOString();
  const configSecretId = String(
    process.env.SEED_CONFIG_SECRET_ID || `${prefix}/app-config`,
  ).trim();
  const integritySecretId = String(
    process.env.SEED_INTEGRITY_SECRET_ID || `${prefix}/integrity`,
  ).trim();
  if (!configSecretId || !integritySecretId) {
    throw new Error("SEED_CONFIG_SECRET_ID and SEED_INTEGRITY_SECRET_ID must not be empty.");
  }

  const appConfig = {
    schemaVersion: 1,
    environment,
    updatedAt: now,
    limits: {
      lengthMin: 4,
      lengthMax: 256,
      specialCountMax: 64,
      digitCountMax: 64,
      mixedCaseCountMax: 128,
      wordCountMin: 2,
      wordCountMax: 16,
      requestsPerMinute: rateLimit,
    },
    features: {
      characters: true,
      passphrase: true,
      qrCode: true,
      historySize: 10,
    },
    wordlist: {
      // "warn" keeps generation available if the word list is updated without
      // re-seeding; set to "enforce" to refuse passphrases on a hash mismatch.
      enforcement: "warn",
    },
  };

  const integrity = {
    schemaVersion: 1,
    algorithm: "sha256",
    wordlistSha256,
    wordlistPath,
    updatedAt: now,
  };

  info(`Seeding secrets for environment: ${environment}`);
  info(`Secrets Manager: ${resolveEndpoint()} (${resolveCredentials().region})`);
  info(`Word list: ${wordlistPath}`);
  info(`SHA-256:   ${wordlistSha256}`);
  info("");

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  async function ensure(secretId, value, description) {
    let exists = false;
    try {
      await call("DescribeSecret", { SecretId: secretId });
      exists = true;
    } catch (error) {
      if (error.code !== "ResourceNotFoundException") {
        throw error;
      }
    }

    if (exists && !force) {
      unchanged += 1;
      info(`= ${secretId} (exists, unchanged)`);
      return;
    }
    if (exists) {
      await call("PutSecretValue", { SecretId: secretId, SecretString: value });
      updated += 1;
      info(`~ ${secretId} (updated)`);
      return;
    }
    await call("CreateSecret", {
      Name: secretId,
      SecretString: value,
      Description: description,
      Tags: [
        { Key: "managed-by", Value: "bin/start.sh" },
        { Key: "environment", Value: environment },
      ],
    });
    created += 1;
    info(`+ ${secretId} (created)`);
  }

  await ensure(
    configSecretId,
    `${JSON.stringify(appConfig, null, 2)}\n`,
    "Password generator runtime policy (managed by bin/start.sh)",
  );
  await ensure(
    integritySecretId,
    `${JSON.stringify(integrity, null, 2)}\n`,
    "Word list integrity digest (managed by bin/start.sh)",
  );

  info("");
  info(`Done: ${created} created, ${updated} updated, ${unchanged} unchanged.`);
  if (unchanged > 0 && !force) {
    info("Use SEED_FORCE=true (./bin/start.sh secrets seed --force) to overwrite.");
  }
}

main().catch((error) => {
  const code = error && error.code ? ` [${error.code}]` : "";
  process.stderr.write(`Seeding failed${code}: ${error.message}\n`);
  process.exit(1);
});
