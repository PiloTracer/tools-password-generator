import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  accessDenied,
  clientNotFound,
  invalidParameter,
  invalidRequest,
  resourceExists,
  resourceNotFound,
} from "./errors.mjs";
import { isPlainObject, randomAlphanumeric, toInteger } from "./util.mjs";

const NAME_PATTERN = /^[a-zA-Z0-9/_+=.@-]+$/;
const VERSION_STAGE_PATTERN = /^[a-zA-Z0-9_]+$/;
const CLIENT_TOKEN_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const CLIENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACCESS_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
const MAX_CLIENT_DESCRIPTION_LENGTH = 512;
const MAX_CLIENT_PREFIXES = 16;
const MAX_MANAGED_CLIENTS = 100;

/**
 * @param {string} name
 * @param {string[]|null|undefined} scopePrefixes
 */
function isNameInScope(name, scopePrefixes) {
  if (scopePrefixes === null || scopePrefixes === undefined) {
    return true;
  }
  return scopePrefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
function parseMasterKey(value) {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) {
    return decoded;
  }
  throw new Error(
    "SM_MASTER_KEY must be 32 bytes: 64 hex characters or a base64 encoded 32-byte key.",
  );
}

/**
 * @param {unknown} input
 * @param {string} field
 * @returns {string}
 */
function requireInputString(input, field) {
  if (!isPlainObject(input) || typeof input[field] !== "string" || input[field].length === 0) {
    throw invalidParameter(`${field} is required.`);
  }
  return input[field];
}

/**
 * An encrypted, versioned secret store that implements the subset of the AWS
 * Secrets Manager data model used by this stack.
 *
 * Values are encrypted with AES-256-GCM. Metadata (names, ARNs, tags, dates and
 * staging labels) stays in plaintext inside the same file; only the secret
 * material is encrypted. The master key lives either in the SM_MASTER_KEY
 * environment variable or in /data/master.key inside the persistent volume.
 */
export class SecretStore {
  /**
   * @param {{
   *   dataDir: string,
   *   region: string,
   *   accountId: string,
   *   masterKey?: string,
   *   maxSecretBytes?: number,
   *   recoveryWindowDays?: number,
   *   logger?: {info: Function, warn: Function, error: Function, debug: Function},
   *   staticClients?: Array<Record<string, any>>,
   *   reservedAccessKeyIds?: string[],
   * }} options
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.region = options.region;
    this.accountId = options.accountId;
    this.masterKeyInput = options.masterKey || "";
    this.maxSecretBytes = options.maxSecretBytes ?? 65536;
    this.recoveryWindowDays = options.recoveryWindowDays ?? 30;
    this.logger = options.logger;
    this.storePath = path.join(this.dataDir, "store.json");
    this.keyPath = path.join(this.dataDir, "master.key");
    this.staticClients = Array.isArray(options.staticClients)
      ? options.staticClients.map((client) => ({
          name: String(client.name || client.accessKeyId || ""),
          accessKeyId: String(client.accessKeyId || ""),
          secretAccessKey: String(client.secretAccessKey || ""),
          sessionToken: String(client.sessionToken || ""),
          description: String(client.description || ""),
          allowedPrefixes: Array.isArray(client.allowedPrefixes)
            ? client.allowedPrefixes.map(String)
            : [],
        }))
      : [];
    this.reservedAccessKeyIds = new Set([
      ...(Array.isArray(options.reservedAccessKeyIds)
        ? options.reservedAccessKeyIds.map(String)
        : []),
      ...this.staticClients.map((client) => client.accessKeyId),
    ]);
    /** @type {Array<Record<string, any>>} */
    this.managedPrincipals = [];
    /** @type {Buffer|null} */
    this.masterKey = null;
    /** @type {string} */
    this.masterKeySource = "unknown";
    /** @type {{schemaVersion: number, createdAt: number, updatedAt?: number, secrets: Array<Record<string, any>>, clients: Array<Record<string, any>>}|null} */
    this.data = null;
    this.ready = false;
  }

  /**
   * Create the data directory, load the encryption key and read the store.
   * @returns {this}
   */
  init() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.masterKey = this.loadMasterKey();
    this.data = this.loadData();
    this.loadManagedClients();
    const purged = this.purgeExpiredDeletions();
    if (purged > 0) {
      this.logger?.info("purged expired secret deletions", { count: purged });
      this.persist();
    }
    this.verifyReadable();
    this.ready = true;
    return this;
  }

  /**
   * @returns {Buffer}
   */
  loadMasterKey() {
    const provided = String(this.masterKeyInput || "").trim();
    if (provided) {
      this.masterKeySource = "env";
      return parseMasterKey(provided);
    }

    if (fs.existsSync(this.keyPath)) {
      this.masterKeySource = "file";
      return parseMasterKey(fs.readFileSync(this.keyPath, "utf8"));
    }

    const generated = crypto.randomBytes(32);
    try {
      fs.writeFileSync(this.keyPath, `${generated.toString("base64")}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      this.logger?.warn(
        "generated a new encryption key inside the data volume; back up the volume to keep it",
      );
    } catch (error) {
      if (error && error.code === "EEXIST") {
        this.masterKeySource = "file";
        return parseMasterKey(fs.readFileSync(this.keyPath, "utf8"));
      }
      throw error;
    }
    this.masterKeySource = "file";
    return generated;
  }

  /**
   * @returns {{schemaVersion: number, createdAt: number, updatedAt?: number, secrets: Array<Record<string, any>>, clients: Array<Record<string, any>>}}
   */
  loadData() {
    if (!fs.existsSync(this.storePath)) {
      const initial = {
        schemaVersion: 1,
        createdAt: Date.now(),
        secrets: [],
        clients: [],
      };
      this.data = initial;
      this.persist();
      return initial;
    }

    const raw = fs.readFileSync(this.storePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`The secrets store is corrupt (${this.storePath}): ${error.message}`);
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.secrets)) {
      throw new Error(`The secrets store has an unexpected shape: ${this.storePath}`);
    }
    for (const secret of parsed.secrets) {
      if (
        !isPlainObject(secret) ||
        typeof secret.name !== "string" ||
        typeof secret.arn !== "string" ||
        !Array.isArray(secret.versions)
      ) {
        throw new Error(`The secrets store contains an invalid secret record: ${this.storePath}`);
      }
    }
    if (parsed.clients === undefined) {
      parsed.clients = [];
    }
    if (!Array.isArray(parsed.clients)) {
      throw new Error(`The secrets store has an unexpected shape: ${this.storePath}`);
    }
    for (const client of parsed.clients) {
      if (
        !isPlainObject(client) ||
        typeof client.name !== "string" ||
        client.name.length === 0 ||
        typeof client.accessKeyId !== "string" ||
        client.accessKeyId.length === 0 ||
        typeof client.secretCiphertext !== "string" ||
        typeof client.createdAt !== "number" ||
        (client.description !== undefined && typeof client.description !== "string") ||
        !Array.isArray(client.allowedPrefixes) ||
        client.allowedPrefixes.length === 0 ||
        !client.allowedPrefixes.every(
          (prefix) => typeof prefix === "string" && prefix.length > 0,
        )
      ) {
        throw new Error(
          `The secrets store contains an invalid client credential record: ${this.storePath}`,
        );
      }
    }
    return parsed;
  }

  /**
   * Verify that every stored ciphertext can be decrypted with the loaded key.
   * Fails fast if the master key does not match the store.
   */
  verifyReadable() {
    for (const secret of this.data.secrets) {
      for (const version of secret.versions) {
        try {
          this.readVersion(secret, version);
        } catch (error) {
          throw new Error(
            `Unable to decrypt secret '${secret.name}' (${version.versionId}). ` +
              "The master key does not match this store. Restore the matching key or volume backup. " +
              `(${error.message})`,
          );
        }
      }
    }
  }

  /**
   * Load managed client credentials and decrypt their secrets into memory.
   * Fails fast if the master key is wrong or a stored credential collides with
   * a credential supplied through SM_CLIENTS_JSON.
   */
  loadManagedClients() {
    if (!Array.isArray(this.data.clients)) {
      this.data.clients = [];
    }
    const knownAccessKeyIds = new Set(this.reservedAccessKeyIds);
    const knownNames = new Set(this.staticClients.map((client) => client.name));
    this.managedPrincipals = [];
    for (const client of this.data.clients) {
      if (knownAccessKeyIds.has(client.accessKeyId)) {
        throw new Error(
          `The stored client credential '${client.name}' conflicts with a static credential ` +
            `(access key ${client.accessKeyId}). Remove one of them.`,
        );
      }
      if (knownNames.has(client.name)) {
        throw new Error(
          `The stored client credential '${client.name}' conflicts with a static credential ` +
            "of the same name. Remove one of them.",
        );
      }
      let secretAccessKey;
      try {
        secretAccessKey = this.decrypt(client.secretCiphertext, this.buildClientAad(client));
      } catch (error) {
        throw new Error(
          `Unable to decrypt client credential '${client.name}'. ` +
            "The master key does not match this store. Restore the matching key or volume backup. " +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
      }
      this.managedPrincipals.push({
        accessKeyId: client.accessKeyId,
        secretAccessKey,
        sessionToken: "",
        name: client.name,
        admin: false,
        allowedPrefixes: [...client.allowedPrefixes],
      });
      knownAccessKeyIds.add(client.accessKeyId);
      knownNames.add(client.name);
    }
  }

  /**
   * Prefix-scoped principals managed by the service (not static env clients).
   * @returns {Array<Record<string, any>>}
   */
  authPrincipals() {
    return this.managedPrincipals;
  }

  /**
   * @returns {number}
   */
  managedClientCount() {
    return this.data ? this.data.clients.length : 0;
  }

  /**
   * @param {Record<string, any>} client
   * @returns {string}
   */
  buildClientAad(client) {
    return `client|${client.name}|${client.accessKeyId}`;
  }

  /**
   * @param {Record<string, any>} record
   * @param {"static"|"managed"} source
   * @returns {Record<string, any>}
   */
  clientMetadata(record, source) {
    /** @type {Record<string, any>} */
    const metadata = {
      Name: record.name,
      AccessKeyId: record.accessKeyId,
      Description: record.description || "",
      AllowedPrefixes: [...record.allowedPrefixes],
      Source: source,
    };
    if (source === "managed") {
      metadata.CreatedDate = record.createdAt / 1000;
      metadata.LastUpdatedDate = (record.updatedAt || record.createdAt) / 1000;
      metadata.CreatedBy = record.createdBy || "instance-admin";
    }
    return metadata;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  clientNameExists(name) {
    return (
      this.staticClients.some((client) => client.name === name) ||
      this.data.clients.some((client) => client.name === name)
    );
  }

  /**
   * @param {string} accessKeyId
   * @returns {boolean}
   */
  accessKeyIdExists(accessKeyId) {
    return (
      this.reservedAccessKeyIds.has(accessKeyId) ||
      this.data.clients.some((client) => client.accessKeyId === accessKeyId)
    );
  }

  /**
   * @returns {string}
   */
  generateAccessKeyId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = `AKIA${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
      if (!this.accessKeyIdExists(candidate)) {
        return candidate;
      }
    }
    throw new Error("Unable to allocate a unique client access key id.");
  }

  /**
   * @param {unknown} raw
   * @returns {string}
   */
  normalizeClientDescription(raw) {
    if (raw === undefined) {
      return "";
    }
    if (typeof raw !== "string") {
      throw invalidParameter("Description must be a string.");
    }
    const description = raw.trim();
    if (description.length > MAX_CLIENT_DESCRIPTION_LENGTH) {
      throw invalidParameter(
        `Description must be ${MAX_CLIENT_DESCRIPTION_LENGTH} characters or fewer.`,
      );
    }
    return description;
  }

  /**
   * @param {unknown} raw
   * @param {string} name
   * @returns {string[]}
   */
  normalizeClientPrefixes(raw, name) {
    if (raw === undefined) {
      return [`client/${name}/`];
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CLIENT_PREFIXES) {
      throw invalidParameter(
        `AllowedPrefixes must be an array of 1-${MAX_CLIENT_PREFIXES} strings.`,
      );
    }
    const prefixes = [];
    for (const value of raw) {
      if (typeof value !== "string" || value.trim() === "") {
        throw invalidParameter("AllowedPrefixes entries must be non-empty strings.");
      }
      let prefix = value.trim();
      if (!prefix.endsWith("/")) {
        prefix += "/";
      }
      if (prefix.length > 512 || !NAME_PATTERN.test(prefix)) {
        throw invalidParameter(
          "AllowedPrefixes entries must be 1-512 characters containing only letters, " +
            "numbers, and /_+=.@- characters.",
        );
      }
      if (!prefixes.includes(prefix)) {
        prefixes.push(prefix);
      }
    }
    return prefixes;
  }

  /**
   * Resolve a client credential by name and/or access key id.
   * @param {Record<string, any>} input
   * @returns {{record: Record<string, any>, source: "static"|"managed"}}
   */
  resolveClient(input) {
    if (input.Name !== undefined && typeof input.Name !== "string") {
      throw invalidParameter("Name must be a string.");
    }
    if (input.AccessKeyId !== undefined && typeof input.AccessKeyId !== "string") {
      throw invalidParameter("AccessKeyId must be a string.");
    }
    const name = typeof input.Name === "string" ? input.Name.trim() : "";
    const accessKeyId = typeof input.AccessKeyId === "string" ? input.AccessKeyId.trim() : "";
    if (!name && !accessKeyId) {
      throw invalidParameter("Name or AccessKeyId is required.");
    }
    const matches = (client) =>
      (!name || client.name === name) &&
      (!accessKeyId || client.accessKeyId === accessKeyId);

    const staticClient = this.staticClients.find(matches);
    if (staticClient) {
      return { record: staticClient, source: "static" };
    }
    const managedClient = this.data.clients.find(matches);
    if (managedClient) {
      return { record: managedClient, source: "managed" };
    }
    throw clientNotFound();
  }

  /**
   * @returns {Record<string, any>}
   */
  listClientCredentials() {
    const clients = [
      ...this.staticClients.map((client) => this.clientMetadata(client, "static")),
      ...this.data.clients.map((client) => this.clientMetadata(client, "managed")),
    ];
    clients.sort((left, right) =>
      left.Name < right.Name ? -1 : left.Name > right.Name ? 1 : 0,
    );
    return { ClientCredentialList: clients };
  }

  /**
   * @param {Record<string, any>} input
   * @returns {Record<string, any>}
   */
  getClientCredential(input) {
    const { record, source } = this.resolveClient(input);
    let secretAccessKey;
    if (source === "static") {
      secretAccessKey = record.secretAccessKey;
    } else {
      try {
        secretAccessKey = this.decrypt(record.secretCiphertext, this.buildClientAad(record));
      } catch (error) {
        throw new Error(
          `Unable to decrypt client credential '${record.name}': ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    return {
      ...this.clientMetadata(record, source),
      SecretAccessKey: secretAccessKey,
      SessionToken: source === "static" ? record.sessionToken || "" : "",
    };
  }

  /**
   * Create a managed, prefix-scoped client credential.
   * @param {Record<string, any>} input
   * @param {string} [createdBy]
   * @returns {Record<string, any>}
   */
  createClientCredential(input, createdBy = "instance-admin") {
    if (!isPlainObject(input)) {
      throw invalidParameter("The request body must be a JSON object.");
    }
    if (this.data.clients.length >= MAX_MANAGED_CLIENTS) {
      throw invalidRequest(
        `The managed client credential limit (${MAX_MANAGED_CLIENTS}) has been reached.`,
      );
    }
    if (
      typeof input.Name !== "string" ||
      input.Name.trim() === "" ||
      !CLIENT_NAME_PATTERN.test(input.Name.trim())
    ) {
      throw invalidParameter(
        "Name must be 1-64 characters, start with a letter or number, and contain only " +
          "letters, numbers, dots, underscores or hyphens.",
      );
    }
    const name = input.Name.trim();
    if (this.clientNameExists(name)) {
      throw resourceExists(`A client credential named '${name}' already exists.`);
    }

    let accessKeyId;
    if (input.AccessKeyId === undefined) {
      accessKeyId = this.generateAccessKeyId();
    } else {
      if (
        typeof input.AccessKeyId !== "string" ||
        !ACCESS_KEY_ID_PATTERN.test(input.AccessKeyId.trim())
      ) {
        throw invalidParameter(
          "AccessKeyId must be 8-64 characters, start with a letter or number, and contain " +
            "only letters, numbers, dots, underscores or hyphens.",
        );
      }
      accessKeyId = input.AccessKeyId.trim();
      if (this.accessKeyIdExists(accessKeyId)) {
        throw resourceExists(
          `A client credential with access key id '${accessKeyId}' already exists.`,
        );
      }
    }

    const description = this.normalizeClientDescription(input.Description);
    const allowedPrefixes = this.normalizeClientPrefixes(input.AllowedPrefixes, name);
    const secretAccessKey = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const record = {
      name,
      description,
      accessKeyId,
      allowedPrefixes,
      secretCiphertext: this.encrypt(
        secretAccessKey,
        this.buildClientAad({ name, accessKeyId }),
      ),
      createdAt: now,
      updatedAt: now,
      createdBy: String(createdBy || "instance-admin"),
    };
    this.data.clients.push(record);
    this.persist();
    this.managedPrincipals.push({
      accessKeyId,
      secretAccessKey,
      sessionToken: "",
      name,
      admin: false,
      allowedPrefixes: [...allowedPrefixes],
    });
    return {
      ...this.clientMetadata(record, "managed"),
      SecretAccessKey: secretAccessKey,
      SessionToken: "",
    };
  }

  /**
   * Delete a managed client credential. Static env credentials are read-only.
   * @param {Record<string, any>} input
   * @returns {Record<string, any>}
   */
  deleteClientCredential(input) {
    const { record, source } = this.resolveClient(input);
    if (source === "static") {
      throw invalidRequest(
        "Client credentials from SM_CLIENTS_JSON are read-only. Remove the entry from the " +
          "environment file and recreate the Secrets Manager container.",
      );
    }
    this.data.clients = this.data.clients.filter(
      (client) => client.accessKeyId !== record.accessKeyId,
    );
    this.managedPrincipals = this.managedPrincipals.filter(
      (principal) => principal.accessKeyId !== record.accessKeyId,
    );
    this.persist();
    return {
      Name: record.name,
      AccessKeyId: record.accessKeyId,
      DeletionDate: Date.now() / 1000,
    };
  }

  /**
   * @param {string} plaintext
   * @param {string} aad
   * @returns {string}
   */
  encrypt(plaintext, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv, {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
  }

  /**
   * @param {string} payload
   * @param {string} aad
   * @returns {string}
   */
  decrypt(payload, aad) {
    const parts = String(payload).split(":");
    if (parts.length !== 4 || parts[0] !== "v1") {
      throw new Error("Unsupported secret ciphertext format.");
    }
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ciphertext = Buffer.from(parts[3], "base64");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error("Invalid secret ciphertext header.");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey, iv, {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  /**
   * @param {Record<string, any>} secret
   * @param {string} versionId
   * @returns {string}
   */
  buildAad(secret, versionId) {
    return `${secret.arn}|${versionId}`;
  }

  /**
   * @param {Record<string, any>} secret
   * @param {Record<string, any>} version
   * @returns {{value: string, binary: boolean}}
   */
  readVersion(secret, version) {
    const decrypted = this.decrypt(version.ciphertext, this.buildAad(secret, version.versionId));
    const parsed = JSON.parse(decrypted);
    if (!isPlainObject(parsed) || typeof parsed.value !== "string") {
      throw new Error("Stored secret payload is invalid.");
    }
    return { value: parsed.value, binary: parsed.binary === true };
  }

  /**
   * @param {Record<string, any>} secret
   * @param {Record<string, any>} input
   * @returns {{version: Record<string, any>, created: boolean}}
   */
  addVersion(secret, input) {
    const hasString = input.SecretString !== undefined;
    const hasBinary = input.SecretBinary !== undefined;
    if (hasString && hasBinary) {
      throw invalidParameter("You can't specify both SecretString and SecretBinary.");
    }
    if (!hasString && !hasBinary) {
      throw invalidParameter("You must specify either SecretString or SecretBinary.");
    }

    let value;
    let binary = false;
    if (hasString) {
      if (typeof input.SecretString !== "string") {
        throw invalidParameter("SecretString must be a string.");
      }
      value = input.SecretString;
      if (Buffer.byteLength(value, "utf8") > this.maxSecretBytes) {
        throw invalidParameter(
          `SecretString must be ${this.maxSecretBytes} bytes or fewer.`,
        );
      }
    } else {
      if (typeof input.SecretBinary !== "string") {
        throw invalidParameter("SecretBinary must be a base64 encoded string.");
      }
      if (!BASE64_PATTERN.test(input.SecretBinary) || input.SecretBinary.length % 4 !== 0) {
        throw invalidParameter("SecretBinary must be valid base64.");
      }
      const decoded = Buffer.from(input.SecretBinary, "base64");
      if (decoded.length > this.maxSecretBytes) {
        throw invalidParameter(
          `SecretBinary must be ${this.maxSecretBytes} bytes or fewer.`,
        );
      }
      value = input.SecretBinary;
      binary = true;
    }

    let clientRequestToken = null;
    if (input.ClientRequestToken !== undefined) {
      if (
        typeof input.ClientRequestToken !== "string" ||
        !CLIENT_TOKEN_PATTERN.test(input.ClientRequestToken)
      ) {
        throw invalidParameter(
          "ClientRequestToken must be 1-64 characters containing letters, numbers or hyphens.",
        );
      }
      clientRequestToken = input.ClientRequestToken;
      const existing = secret.versions.find(
        (version) => version.clientRequestToken === clientRequestToken,
      );
      if (existing) {
        return { version: existing, created: false };
      }
    }

    let stages;
    if (input.VersionStages === undefined) {
      stages = ["AWSCURRENT"];
    } else {
      if (
        !Array.isArray(input.VersionStages) ||
        input.VersionStages.length === 0 ||
        input.VersionStages.length > 20
      ) {
        throw invalidParameter("VersionStages must be an array of 1 to 20 staging labels.");
      }
      stages = [];
      for (const stage of input.VersionStages) {
        if (
          typeof stage !== "string" ||
          stage.length < 1 ||
          stage.length > 256 ||
          !VERSION_STAGE_PATTERN.test(stage)
        ) {
          throw invalidParameter(
            "VersionStages entries must be 1-256 characters containing letters, numbers or underscores.",
          );
        }
        if (stage === "AWSPREVIOUS") {
          throw invalidParameter(
            "AWSPREVIOUS is managed by Secrets Manager and can't be specified directly.",
          );
        }
        if (!stages.includes(stage)) {
          stages.push(stage);
        }
      }
    }

    const versionId = crypto.randomUUID();
    const now = Date.now();
    const previousCurrent = secret.versions.find((version) =>
      version.stages.includes("AWSCURRENT"),
    );

    // A staging label points at exactly one version.
    for (const stage of stages) {
      for (const other of secret.versions) {
        other.stages = other.stages.filter((candidate) => candidate !== stage);
      }
    }

    if (stages.includes("AWSCURRENT")) {
      for (const other of secret.versions) {
        other.stages = other.stages.filter((candidate) => candidate !== "AWSPREVIOUS");
      }
      if (previousCurrent && !previousCurrent.stages.includes("AWSPREVIOUS")) {
        previousCurrent.stages.push("AWSPREVIOUS");
      }
    }

    const version = {
      versionId,
      stages,
      createdDate: now,
      ciphertext: this.encrypt(
        JSON.stringify({ value, binary }),
        this.buildAad(secret, versionId),
      ),
      binary,
      clientRequestToken,
    };
    secret.versions.push(version);
    secret.lastChangedDate = now;
    return { version, created: true };
  }

  /**
   * @returns {number}
   */
  purgeExpiredDeletions() {
    const now = Date.now();
    const before = this.data.secrets.length;
    this.data.secrets = this.data.secrets.filter(
      (secret) => !(secret.deletedDate && secret.deletedDate <= now),
    );
    return before - this.data.secrets.length;
  }

  persist() {
    const json = `${JSON.stringify({ ...this.data, updatedAt: Date.now() }, null, 2)}\n`;
    const tempPath = `${this.storePath}.tmp-${process.pid}-${Date.now()}`;
    const handle = fs.openSync(tempPath, "w", 0o600);
    try {
      fs.writeFileSync(handle, json, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tempPath, this.storePath);
    try {
      const dirHandle = fs.openSync(this.dataDir, "r");
      fs.fsyncSync(dirHandle);
      fs.closeSync(dirHandle);
    } catch {
      // Directory fsync is not supported on every file system.
    }
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  buildArn(name) {
    const used = new Set(this.data.secrets.map((secret) => secret.arn));
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const suffix = randomAlphanumeric(6);
      const arn = `arn:aws:secretsmanager:${this.region}:${this.accountId}:secret:${name}-${suffix}`;
      if (!used.has(arn)) {
        return arn;
      }
    }
    throw new Error("Unable to allocate a unique ARN suffix.");
  }

  /**
   * @param {string} name
   */
  validateName(name) {
    if (name.length > 512 || !NAME_PATTERN.test(name)) {
      throw invalidParameter(
        "Name must be 1-512 characters containing only letters, numbers, and /_+=.@- characters.",
      );
    }
  }

  /**
   * @param {string} secretId
   * @returns {Record<string, any>}
   */
  findSecret(secretId) {
    for (const secret of this.data.secrets) {
      if (secret.arn === secretId) {
        return secret;
      }
    }

    const candidates = [secretId];
    if (secretId.startsWith("arn:aws:secretsmanager:")) {
      const marker = ":secret:";
      const index = secretId.indexOf(marker);
      if (index >= 0) {
        candidates.push(secretId.slice(index + marker.length));
      }
    }
    const withoutSuffix = secretId.replace(/-[A-Za-z0-9]{6}$/, "");
    if (withoutSuffix !== secretId) {
      candidates.push(withoutSuffix);
    }

    for (const candidate of candidates) {
      const match = this.data.secrets.find((secret) => secret.name === candidate);
      if (match) {
        return match;
      }
    }
    throw resourceNotFound();
  }

  /**
   * @param {Record<string, any>} secret
   */
  assertNotDeleted(secret) {
    if (secret.deletedDate) {
      throw invalidRequest(
        "You can't perform this operation on the secret because it was marked for deletion.",
      );
    }
  }

  /**
   * @param {unknown} raw
   * @returns {Record<string, string>}
   */
  normalizeTags(raw) {
    if (raw === undefined) {
      return {};
    }
    if (!Array.isArray(raw)) {
      throw invalidParameter("Tags must be an array of {Key, Value} objects.");
    }
    /** @type {Record<string, string>} */
    const tags = {};
    for (const tag of raw) {
      if (!isPlainObject(tag) || typeof tag.Key !== "string") {
        throw invalidParameter("Each tag must be an object with a string Key.");
      }
      if (tag.Key.length < 1 || tag.Key.length > 128) {
        throw invalidParameter("Tag keys must be 1-128 characters.");
      }
      const value = tag.Value === undefined ? "" : tag.Value;
      if (typeof value !== "string" || value.length > 256) {
        throw invalidParameter("Tag values must be strings of 256 characters or fewer.");
      }
      tags[tag.Key] = value;
    }
    return tags;
  }

  /**
   * @param {Record<string, string>} tags
   * @returns {Array<{Key: string, Value: string}>}
   */
  tagsToArray(tags) {
    return Object.entries(tags || {}).map(([Key, Value]) => ({ Key, Value }));
  }

  /**
   * @param {unknown} raw
   * @returns {Array<{key: string, values: string[]}>}
   */
  parseFilters(raw) {
    if (raw === undefined) {
      return [];
    }
    if (!Array.isArray(raw)) {
      throw invalidParameter("Filters must be an array.");
    }
    const allowed = new Set(["description", "name", "tag-key", "tag-value", "all"]);
    return raw.map((filter, index) => {
      if (!isPlainObject(filter) || typeof filter.Key !== "string") {
        throw invalidParameter(`Filters[${index}] must be an object with a string Key.`);
      }
      if (!allowed.has(filter.Key)) {
        throw invalidParameter(`Unsupported filter key: ${filter.Key}`);
      }
      if (!Array.isArray(filter.Values) || filter.Values.length === 0 || filter.Values.length > 10) {
        throw invalidParameter(`Filters[${index}].Values must contain 1-10 values.`);
      }
      return {
        key: filter.Key,
        values: filter.Values.map((value) => String(value)),
      };
    });
  }

  /**
   * @param {Record<string, any>} secret
   * @param {Array<{key: string, values: string[]}>} filters
   * @returns {boolean}
   */
  matchesFilters(secret, filters) {
    return filters.every((filter) => {
      switch (filter.key) {
        case "name":
          return filter.values.some((value) => secret.name.includes(value));
        case "description":
          return filter.values.some((value) => (secret.description || "").includes(value));
        case "tag-key":
          return filter.values.some((value) =>
            Object.keys(secret.tags || {}).includes(value),
          );
        case "tag-value":
          return filter.values.some((value) =>
            Object.values(secret.tags || {}).includes(value),
          );
        case "all":
          return filter.values.some(
            (value) =>
              secret.name.includes(value) ||
              (secret.description || "").includes(value) ||
              Object.entries(secret.tags || {}).some(
                ([key, tagValue]) => key.includes(value) || tagValue.includes(value),
              ),
          );
        default:
          return false;
      }
    });
  }

  /**
   * @param {Array<any>} items
   * @param {unknown} maxResultsRaw
   * @param {unknown} nextTokenRaw
   * @param {number} defaultMax
   * @param {number} hardMax
   * @returns {{page: Array<any>, nextToken?: string}}
   */
  paginate(items, maxResultsRaw, nextTokenRaw, defaultMax, hardMax) {
    const maxResults =
      maxResultsRaw === undefined ? defaultMax : toInteger(maxResultsRaw);
    if (maxResults === undefined || maxResults < 1 || maxResults > hardMax) {
      throw invalidParameter(`MaxResults must be between 1 and ${hardMax}.`);
    }

    let offset = 0;
    if (nextTokenRaw !== undefined) {
      if (typeof nextTokenRaw !== "string" || nextTokenRaw.length === 0) {
        throw invalidParameter("NextToken must be a non-empty string.");
      }
      const decoded = Buffer.from(nextTokenRaw, "base64").toString("utf8");
      if (!/^\d+$/.test(decoded)) {
        throw invalidParameter("Invalid NextToken.");
      }
      offset = Number(decoded);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw invalidParameter("Invalid NextToken.");
      }
    }

    const page = items.slice(offset, offset + maxResults);
    const nextOffset = offset + page.length;
    return {
      page,
      nextToken:
        nextOffset < items.length
          ? Buffer.from(String(nextOffset)).toString("base64")
          : undefined,
    };
  }

  /** @param {Record<string, any>} input */
  createSecret(input) {
    const name = requireInputString(input, "Name");
    this.validateName(name);
    if (this.data.secrets.some((secret) => secret.name === name)) {
      throw resourceExists();
    }
    if (input.SecretString !== undefined && input.SecretBinary !== undefined) {
      throw invalidParameter("You can't specify both SecretString and SecretBinary.");
    }

    const arn = this.buildArn(name);
    const now = Date.now();
    const secret = {
      name,
      arn,
      description: typeof input.Description === "string" ? input.Description : "",
      tags: this.normalizeTags(input.Tags),
      createdDate: now,
      lastChangedDate: now,
      lastAccessedDate: null,
      deletedDate: null,
      kmsKeyId: typeof input.KmsKeyId === "string" ? input.KmsKeyId : null,
      versions: [],
    };

    let version;
    if (input.SecretString !== undefined || input.SecretBinary !== undefined) {
      version = this.addVersion(secret, input).version;
    }

    this.data.secrets.push(secret);
    this.persist();

    /** @type {Record<string, any>} */
    const response = { ARN: arn, Name: name };
    if (version) {
      response.VersionId = version.versionId;
      response.VersionStages = [...version.stages];
    }
    return response;
  }

  /** @param {Record<string, any>} input */
  putSecretValue(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    this.assertNotDeleted(secret);
    const { version, created } = this.addVersion(secret, input);
    if (created) {
      this.persist();
    }
    return {
      ARN: secret.arn,
      Name: secret.name,
      VersionId: version.versionId,
      VersionStages: [...version.stages],
    };
  }

  /** @param {Record<string, any>} input */
  getSecretValue(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    this.assertNotDeleted(secret);

    let version;
    if (input.VersionId !== undefined) {
      if (typeof input.VersionId !== "string" || input.VersionId.length === 0) {
        throw invalidParameter("VersionId must be a non-empty string.");
      }
      version = secret.versions.find((candidate) => candidate.versionId === input.VersionId);
    } else {
      const stage =
        input.VersionStage === undefined
          ? "AWSCURRENT"
          : requireInputString(input, "VersionStage");
      version = secret.versions.find((candidate) => candidate.stages.includes(stage));
    }

    if (!version) {
      throw resourceNotFound();
    }

    const { value, binary } = this.readVersion(secret, version);
    secret.lastAccessedDate = Date.now();

    /** @type {Record<string, any>} */
    const response = {
      ARN: secret.arn,
      Name: secret.name,
      VersionId: version.versionId,
      VersionStages: [...version.stages],
      CreatedDate: version.createdDate / 1000,
    };
    if (binary) {
      response.SecretBinary = value;
    } else {
      response.SecretString = value;
    }
    return response;
  }

  /** @param {Record<string, any>} input */
  describeSecret(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    /** @type {Record<string, any>} */
    const response = {
      ARN: secret.arn,
      Name: secret.name,
      Description: secret.description,
      CreatedDate: secret.createdDate / 1000,
      LastChangedDate: secret.lastChangedDate / 1000,
      Tags: this.tagsToArray(secret.tags),
      VersionIdsToStages: {},
      RotationEnabled: false,
    };
    if (secret.lastAccessedDate) {
      response.LastAccessedDate = secret.lastAccessedDate / 1000;
    }
    if (secret.deletedDate) {
      response.DeletedDate = secret.deletedDate / 1000;
    }
    if (secret.kmsKeyId) {
      response.KmsKeyId = secret.kmsKeyId;
    }
    for (const version of secret.versions) {
      response.VersionIdsToStages[version.versionId] = [...version.stages];
    }
    return response;
  }

  /**
   * @param {Record<string, any>} input
   * @param {string[]|null} [scopePrefixes]
   */
  listSecrets(input, scopePrefixes = null) {
    const filters = this.parseFilters(input.Filters);
    const includeDeleted = input.IncludePlannedDeletion === true;

    let secrets = this.data.secrets.filter(
      (secret) =>
        (includeDeleted || !secret.deletedDate) &&
        isNameInScope(secret.name, scopePrefixes),
    );
    if (filters.length > 0) {
      secrets = secrets.filter((secret) => this.matchesFilters(secret, filters));
    }
    secrets = [...secrets].sort((left, right) => left.name.localeCompare(right.name));

    const { page, nextToken } = this.paginate(
      secrets,
      input.MaxResults,
      input.NextToken,
      100,
      100,
    );

    const SecretList = page.map((secret) => {
      /** @type {Record<string, any>} */
      const entry = {
        ARN: secret.arn,
        Name: secret.name,
        Description: secret.description,
        CreatedDate: secret.createdDate / 1000,
        LastChangedDate: secret.lastChangedDate / 1000,
        Tags: this.tagsToArray(secret.tags),
        SecretVersionsToStages: {},
      };
      if (secret.lastAccessedDate) {
        entry.LastAccessedDate = secret.lastAccessedDate / 1000;
      }
      if (secret.deletedDate) {
        entry.DeletedDate = secret.deletedDate / 1000;
      }
      for (const version of secret.versions) {
        entry.SecretVersionsToStages[version.versionId] = [...version.stages];
      }
      return entry;
    });

    /** @type {Record<string, any>} */
    const response = { SecretList };
    if (nextToken) {
      response.NextToken = nextToken;
    }
    return response;
  }

  /** @param {Record<string, any>} input */
  listSecretVersionIds(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    this.assertNotDeleted(secret);

    let versions = [...secret.versions].sort(
      (left, right) => right.createdDate - left.createdDate,
    );
    if (input.IncludeDeprecated !== true) {
      versions = versions.filter((version) => version.stages.length > 0);
    }

    const { page, nextToken } = this.paginate(
      versions,
      input.MaxResults,
      input.NextToken,
      100,
      100,
    );

    /** @type {Record<string, any>} */
    const response = {
      ARN: secret.arn,
      Name: secret.name,
      Versions: page.map((version) => ({
        VersionId: version.versionId,
        VersionStages: [...version.stages],
        CreatedDate: version.createdDate / 1000,
      })),
    };
    if (nextToken) {
      response.NextToken = nextToken;
    }
    return response;
  }

  /** @param {Record<string, any>} input */
  updateSecret(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    this.assertNotDeleted(secret);

    if (input.Description !== undefined) {
      if (typeof input.Description !== "string") {
        throw invalidParameter("Description must be a string.");
      }
      secret.description = input.Description;
    }
    if (input.KmsKeyId !== undefined) {
      if (typeof input.KmsKeyId !== "string") {
        throw invalidParameter("KmsKeyId must be a string.");
      }
      secret.kmsKeyId = input.KmsKeyId;
    }

    let version;
    if (input.SecretString !== undefined || input.SecretBinary !== undefined) {
      version = this.addVersion(secret, input).version;
    }
    secret.lastChangedDate = Date.now();
    this.persist();

    /** @type {Record<string, any>} */
    const response = { ARN: secret.arn, Name: secret.name };
    if (version) {
      response.VersionId = version.versionId;
      response.VersionStages = [...version.stages];
    }
    return response;
  }

  /** @param {Record<string, any>} input */
  deleteSecret(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    const force = input.ForceDeleteWithoutRecovery === true;
    const hasWindow = input.RecoveryWindowInDays !== undefined;

    if (force && hasWindow) {
      throw invalidParameter(
        "You can't specify both ForceDeleteWithoutRecovery and RecoveryWindowInDays.",
      );
    }

    const now = Date.now();
    if (force) {
      this.data.secrets = this.data.secrets.filter(
        (candidate) => candidate.arn !== secret.arn,
      );
      this.persist();
      return { ARN: secret.arn, Name: secret.name, DeletionDate: now / 1000 };
    }

    if (secret.deletedDate) {
      throw invalidRequest("The secret is already marked for deletion.");
    }

    let days = this.recoveryWindowDays;
    if (hasWindow) {
      const parsed = toInteger(input.RecoveryWindowInDays);
      if (parsed === undefined || parsed < 7 || parsed > 30) {
        throw invalidParameter("RecoveryWindowInDays must be between 7 and 30.");
      }
      days = parsed;
    }

    secret.deletedDate = now + days * 86400000;
    secret.lastChangedDate = now;
    this.persist();
    return {
      ARN: secret.arn,
      Name: secret.name,
      DeletionDate: secret.deletedDate / 1000,
    };
  }

  /** @param {Record<string, any>} input */
  restoreSecret(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    if (secret.deletedDate) {
      secret.deletedDate = null;
      secret.lastChangedDate = Date.now();
      this.persist();
    }
    return { ARN: secret.arn, Name: secret.name };
  }

  /** @param {Record<string, any>} input */
  tagResource(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    const tags = this.normalizeTags(input.Tags);
    Object.assign(secret.tags, tags);
    secret.lastChangedDate = Date.now();
    this.persist();
    return {};
  }

  /** @param {Record<string, any>} input */
  untagResource(input) {
    const secret = this.findSecret(requireInputString(input, "SecretId"));
    if (!Array.isArray(input.TagKeys) || input.TagKeys.length === 0) {
      throw invalidParameter("TagKeys is required.");
    }
    for (const key of input.TagKeys) {
      if (typeof key !== "string") {
        throw invalidParameter("TagKeys entries must be strings.");
      }
      delete secret.tags[key];
    }
    secret.lastChangedDate = Date.now();
    this.persist();
    return {};
  }

  /**
   * @param {Record<string, any>} input
   * @param {string[]|null} [scopePrefixes]
   */
  batchGetSecretValue(input, scopePrefixes = null) {
    const hasIds = Array.isArray(input.SecretIdList) && input.SecretIdList.length > 0;
    const hasFilters = Array.isArray(input.Filters) && input.Filters.length > 0;
    if (!hasIds && !hasFilters) {
      throw invalidParameter("You must specify SecretIdList or Filters.");
    }
    if (hasIds && hasFilters) {
      throw invalidParameter("You can't specify both SecretIdList and Filters.");
    }

    /** @type {Array<Record<string, any>>} */
    const errors = [];
    /** @type {Array<Record<string, any>>} */
    let targets = [];

    if (hasIds) {
      if (input.SecretIdList.length > 20) {
        throw invalidParameter("SecretIdList can contain at most 20 entries.");
      }
      for (const secretId of input.SecretIdList) {
        try {
          if (typeof secretId !== "string" || secretId.length === 0) {
            throw invalidParameter("SecretIdList entries must be non-empty strings.");
          }
          const secret = this.findSecret(secretId);
          this.assertNotDeleted(secret);
          if (!isNameInScope(secret.name, scopePrefixes)) {
            throw accessDenied(
              "The client credential is not authorized to access this secret.",
            );
          }
          targets.push(secret);
        } catch (error) {
          errors.push({
            SecretId: typeof secretId === "string" ? secretId : String(secretId),
            ErrorCode: error.type || "ResourceNotFoundException",
            ErrorMessage: error.message,
          });
        }
      }
    } else {
      const filters = this.parseFilters(input.Filters);
      targets = this.data.secrets.filter(
        (secret) =>
          !secret.deletedDate &&
          this.matchesFilters(secret, filters) &&
          isNameInScope(secret.name, scopePrefixes),
      );
    }

    const seen = new Set();
    targets = targets.filter((secret) => {
      if (seen.has(secret.arn)) {
        return false;
      }
      seen.add(secret.arn);
      return true;
    });
    targets.sort((left, right) => left.name.localeCompare(right.name));

    const { page, nextToken } = this.paginate(
      targets,
      input.MaxResults,
      input.NextToken,
      20,
      20,
    );

    /** @type {Array<Record<string, any>>} */
    const SecretValues = [];
    for (const secret of page) {
      const version = secret.versions.find((candidate) =>
        candidate.stages.includes("AWSCURRENT"),
      );
      if (!version) {
        errors.push({
          SecretId: secret.name,
          ErrorCode: "ResourceNotFoundException",
          ErrorMessage: "The secret has no version with the AWSCURRENT staging label.",
        });
        continue;
      }
      const { value, binary } = this.readVersion(secret, version);
      /** @type {Record<string, any>} */
      const entry = {
        ARN: secret.arn,
        Name: secret.name,
        VersionId: version.versionId,
        VersionStages: [...version.stages],
        CreatedDate: version.createdDate / 1000,
      };
      if (binary) {
        entry.SecretBinary = value;
      } else {
        entry.SecretString = value;
      }
      SecretValues.push(entry);
    }

    /** @type {Record<string, any>} */
    const response = { SecretValues };
    if (nextToken) {
      response.NextToken = nextToken;
    }
    if (errors.length > 0) {
      response.Errors = errors;
    }
    return response;
  }

  /** @param {Record<string, any>} input */
  getRandomPassword(input) {
    const length = input.PasswordLength === undefined ? 32 : toInteger(input.PasswordLength);
    if (length === undefined || length < 1 || length > 4096) {
      throw invalidParameter("PasswordLength must be between 1 and 4096.");
    }

    const excluded = new Set(String(input.ExcludeCharacters || "").split(""));
    const pools = [];
    if (input.ExcludeLowercase !== true) {
      pools.push("abcdefghijklmnopqrstuvwxyz");
    }
    if (input.ExcludeUppercase !== true) {
      pools.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    }
    if (input.ExcludeNumbers !== true) {
      pools.push("0123456789");
    }
    if (input.ExcludePunctuation !== true) {
      pools.push("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");
    }

    const filteredPools = pools
      .map((pool) => [...pool].filter((character) => !excluded.has(character)).join(""))
      .filter((pool) => pool.length > 0);

    if (filteredPools.length === 0) {
      throw invalidParameter("The password policy excludes every character type.");
    }

    const requireEach = input.RequireEachIncludedType !== false;
    if (requireEach && length < filteredPools.length) {
      throw invalidParameter(
        "PasswordLength is too short to include every required character type.",
      );
    }

    const characters = [];
    if (requireEach) {
      for (const pool of filteredPools) {
        characters.push(pool[crypto.randomInt(pool.length)]);
      }
    }
    const union = filteredPools.join("");
    while (characters.length < length) {
      characters.push(union[crypto.randomInt(union.length)]);
    }
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swapIndex = crypto.randomInt(index + 1);
      [characters[index], characters[swapIndex]] = [
        characters[swapIndex],
        characters[index],
      ];
    }

    return { RandomPassword: characters.join("") };
  }

  /**
   * @returns {{ok: boolean, secrets: number, deletedSecrets: number, managedClients: number, dataDir: string, writable: boolean, masterKeySource: string}}
   */
  health() {
    let writable = false;
    try {
      fs.accessSync(this.dataDir, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    const secrets = this.data ? this.data.secrets : [];
    return {
      ok: this.ready && writable && Boolean(this.masterKey),
      secrets: secrets.filter((secret) => !secret.deletedDate).length,
      deletedSecrets: secrets.filter((secret) => Boolean(secret.deletedDate)).length,
      managedClients: this.data ? this.data.clients.length : 0,
      dataDir: this.dataDir,
      writable,
      masterKeySource: this.masterKeySource,
    };
  }
}
