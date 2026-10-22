#!/usr/bin/env node
/**
 * Small operator CLI for the AWS-compatible Secrets Manager endpoint.
 * It implements SigV4 itself, so neither the AWS CLI nor an SDK is required.
 *
 * Run it inside the running container:
 *   docker compose exec -T secrets-manager node cli.mjs list-secrets
 * or on a host with Node.js 20+:
 *   SM_ENDPOINT=http://127.0.0.1:18001 SM_ACCESS_KEY_ID=... \
 *   SM_SECRET_ACCESS_KEY=... node secrets-manager/cli.mjs list-secrets
 */
import fs from "node:fs";

import { call, resolveCredentials, resolveEndpoint } from "./client.mjs";

const USAGE = `Usage: node cli.mjs <command> [arguments]

Commands:
  list-secrets [--max N]
  describe-secret <secret-id>
  get-secret-value <secret-id> [--stage STAGE] [--json]
  put-secret-value <secret-id> [value] [--file FILE | --stdin] [--stages A,B]
  create-secret <name> [value] [--file FILE | --stdin] [--description TEXT] [--stages A,B]
  update-secret <secret-id> [value] [--file FILE | --stdin] [--description TEXT]
  delete-secret <secret-id> [--force] [--window DAYS]
  restore-secret <secret-id>
  tag-resource <secret-id> Key=Value [Key=Value ...]
  untag-resource <secret-id> Key [Key ...]
  get-random-password [--length N] [--json]
  batch-get <secret-id> [secret-id ...]
  raw <Operation> [json-payload]
  ping

Environment:
  SM_ENDPOINT (default http://127.0.0.1:8080)
  SM_ACCESS_KEY_ID / SM_SECRET_ACCESS_KEY
  SM_REGION (default us-east-1)
`;

/**
 * @param {string[]} argv
 * @returns {{positional: string[], flags: Record<string, string|boolean>}}
 */
function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json" || argument === "--force" || argument === "--stdin") {
      flags[argument.slice(2)] = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const name = argument.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      flags[name] = value;
      index += 1;
      continue;
    }
    positional.push(argument);
  }
  return { positional, flags };
}

/**
 * @param {string[]} argv
 * @param {number} valueIndex
 * @param {Record<string, string|boolean>} flags
 * @returns {string|undefined}
 */
function readValue(argv, valueIndex, flags) {
  if (typeof flags.file === "string") {
    return stripOneNewline(fs.readFileSync(flags.file, "utf8"));
  }
  if (flags.stdin === true) {
    return stripOneNewline(fs.readFileSync(0, "utf8"));
  }
  if (argv.length > valueIndex) {
    return argv[valueIndex];
  }
  return undefined;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripOneNewline(value) {
  return value.replace(/\r?\n$/, "");
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {Record<string, string|boolean>} flags
 * @returns {string[]|undefined}
 */
function parseStages(flags) {
  if (typeof flags.stages !== "string") {
    return undefined;
  }
  const stages = flags.stages
    .split(",")
    .map((stage) => stage.trim())
    .filter(Boolean);
  return stages.length > 0 ? stages : undefined;
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function run(argv) {
  const command = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));

  switch (command) {
    case "list-secrets": {
      const payload = {};
      if (flags.max !== undefined) {
        payload.MaxResults = Number(flags.max);
      }
      printJson(await call("ListSecrets", payload));
      return;
    }
    case "describe-secret": {
      if (!positional[0]) {
        throw new Error("describe-secret requires a secret id.");
      }
      printJson(await call("DescribeSecret", { SecretId: positional[0] }));
      return;
    }
    case "get-secret-value": {
      if (!positional[0]) {
        throw new Error("get-secret-value requires a secret id.");
      }
      const data = await call("GetSecretValue", {
        SecretId: positional[0],
        ...(typeof flags.stage === "string" ? { VersionStage: flags.stage } : {}),
      });
      if (flags.json === true) {
        printJson(data);
      } else if (typeof data.SecretString === "string") {
        process.stdout.write(`${data.SecretString}\n`);
      } else {
        throw new Error("The secret contains binary data; use --json to inspect it.");
      }
      return;
    }
    case "put-secret-value": {
      if (!positional[0]) {
        throw new Error("put-secret-value requires a secret id.");
      }
      const value = readValue(positional, 1, flags);
      if (value === undefined) {
        throw new Error("put-secret-value requires a value (argument, --file or --stdin).");
      }
      printJson(
        await call("PutSecretValue", {
          SecretId: positional[0],
          SecretString: value,
          ...(parseStages(flags) ? { VersionStages: parseStages(flags) } : {}),
        }),
      );
      return;
    }
    case "create-secret": {
      if (!positional[0]) {
        throw new Error("create-secret requires a name.");
      }
      const value = readValue(positional, 1, flags);
      const payload = {
        Name: positional[0],
        ...(typeof flags.description === "string"
          ? { Description: flags.description }
          : {}),
      };
      if (value !== undefined) {
        payload.SecretString = value;
      }
      if (parseStages(flags)) {
        payload.VersionStages = parseStages(flags);
      }
      printJson(await call("CreateSecret", payload));
      return;
    }
    case "update-secret": {
      if (!positional[0]) {
        throw new Error("update-secret requires a secret id.");
      }
      const value = readValue(positional, 1, flags);
      const payload = { SecretId: positional[0] };
      if (value !== undefined) {
        payload.SecretString = value;
      }
      if (typeof flags.description === "string") {
        payload.Description = flags.description;
      }
      printJson(await call("UpdateSecret", payload));
      return;
    }
    case "delete-secret": {
      if (!positional[0]) {
        throw new Error("delete-secret requires a secret id.");
      }
      const payload = { SecretId: positional[0] };
      if (flags.force === true) {
        payload.ForceDeleteWithoutRecovery = true;
      }
      if (typeof flags.window === "string") {
        payload.RecoveryWindowInDays = Number(flags.window);
      }
      printJson(await call("DeleteSecret", payload));
      return;
    }
    case "restore-secret": {
      if (!positional[0]) {
        throw new Error("restore-secret requires a secret id.");
      }
      printJson(await call("RestoreSecret", { SecretId: positional[0] }));
      return;
    }
    case "tag-resource": {
      if (!positional[0]) {
        throw new Error("tag-resource requires a secret id.");
      }
      const tags = positional.slice(1).map((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0) {
          throw new Error(`Invalid tag '${entry}', expected Key=Value.`);
        }
        return { Key: entry.slice(0, separator), Value: entry.slice(separator + 1) };
      });
      if (tags.length === 0) {
        throw new Error("tag-resource requires at least one Key=Value.");
      }
      printJson(await call("TagResource", { SecretId: positional[0], Tags: tags }));
      return;
    }
    case "untag-resource": {
      if (!positional[0] || positional.length < 2) {
        throw new Error("untag-resource requires a secret id and at least one tag key.");
      }
      printJson(
        await call("UntagResource", {
          SecretId: positional[0],
          TagKeys: positional.slice(1),
        }),
      );
      return;
    }
    case "get-random-password": {
      const payload = {};
      if (flags.length !== undefined) {
        payload.PasswordLength = Number(flags.length);
      }
      const data = await call("GetRandomPassword", payload);
      if (flags.json === true) {
        printJson(data);
      } else {
        process.stdout.write(`${data.RandomPassword}\n`);
      }
      return;
    }
    case "batch-get": {
      if (positional.length === 0) {
        throw new Error("batch-get requires at least one secret id.");
      }
      printJson(await call("BatchGetSecretValue", { SecretIdList: positional }));
      return;
    }
    case "raw": {
      if (!positional[0]) {
        throw new Error("raw requires an operation name, for example: raw ListSecrets");
      }
      const payload = positional[1] ? JSON.parse(positional[1]) : {};
      printJson(await call(positional[0], payload));
      return;
    }
    case "ping": {
      const started = Date.now();
      const data = await call("ListSecrets", { MaxResults: 1 });
      const count = Array.isArray(data.SecretList) ? data.SecretList.length : 0;
      process.stdout.write(
        `OK endpoint=${resolveEndpoint()} region=${resolveCredentials().region} secrets=${count} ms=${Date.now() - started}\n`,
      );
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return;
    default:
      throw new Error(`Unknown command '${command}'. Run with --help for usage.`);
  }
}

run(process.argv.slice(2)).catch((error) => {
  const code = error && error.code ? ` [${error.code}]` : "";
  process.stderr.write(`Error${code}: ${error.message}\n`);
  process.exit(1);
});
