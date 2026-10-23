import { accessDenied, invalidParameter, unknownOperation } from "./errors.mjs";
import { isPlainObject } from "./util.mjs";

/**
 * @typedef {{
 *   accessKeyId?: string,
 *   name?: string,
 *   admin?: boolean,
 *   allowedPrefixes?: string[],
 * }} Principal
 */

/** @param {Principal|null|undefined} principal */
function isAdmin(principal) {
  return !principal || principal.admin === true;
}

/** @param {Principal|null|undefined} principal */
function assertAdmin(principal) {
  if (!isAdmin(principal)) {
    throw accessDenied("Only the instance administrator can manage client credentials.");
  }
}

/** @param {Principal|null|undefined} principal */
function allowedPrefixes(principal) {
  return Array.isArray(principal?.allowedPrefixes)
    ? principal.allowedPrefixes.filter((prefix) => typeof prefix === "string" && prefix.length > 0)
    : [];
}

/**
 * @param {unknown} name
 * @param {Principal|null|undefined} principal
 */
function nameAllowed(name, principal) {
  if (isAdmin(principal)) {
    return true;
  }
  if (typeof name !== "string" || name.length === 0) {
    return true; // Let the store produce the normal InvalidParameterException.
  }
  const prefixes = allowedPrefixes(principal);
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * @param {unknown} name
 * @param {Principal|null|undefined} principal
 */
function assertNameAllowed(name, principal) {
  if (!nameAllowed(name, principal)) {
    throw accessDenied("The client credential is not authorized to access this secret name.");
  }
}

/**
 * @param {import("./store.mjs").SecretStore} store
 * @param {Record<string, any>} input
 * @param {Principal|null|undefined} principal
 */
function assertSecretAllowed(store, input, principal) {
  if (isAdmin(principal) || typeof input.SecretId !== "string" || input.SecretId.length === 0) {
    return;
  }
  const secret = store.findSecret(input.SecretId);
  assertNameAllowed(secret.name, principal);
}

/** @param {Principal|null|undefined} principal */
function scopePrefixes(principal) {
  return isAdmin(principal) ? null : allowedPrefixes(principal);
}

const HANDLERS = Object.freeze({
  BatchGetSecretValue: (store, input, principal) =>
    store.batchGetSecretValue(input, scopePrefixes(principal)),
  CreateClientCredential: (store, input, principal) => {
    assertAdmin(principal);
    return store.createClientCredential(input, principal?.name || "instance-admin");
  },
  CreateSecret: (store, input, principal) => {
    assertNameAllowed(input.Name, principal);
    return store.createSecret(input);
  },
  DeleteClientCredential: (store, input, principal) => {
    assertAdmin(principal);
    return store.deleteClientCredential(input);
  },
  DeleteSecret: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.deleteSecret(input);
  },
  DescribeSecret: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.describeSecret(input);
  },
  GetClientCredential: (store, input, principal) => {
    assertAdmin(principal);
    return store.getClientCredential(input);
  },
  GetRandomPassword: (store, input) => store.getRandomPassword(input),
  GetSecretValue: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.getSecretValue(input);
  },
  ListSecretVersionIds: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.listSecretVersionIds(input);
  },
  ListClientCredentials: (store, _input, principal) => {
    assertAdmin(principal);
    return store.listClientCredentials();
  },
  ListSecrets: (store, input, principal) =>
    store.listSecrets(input, scopePrefixes(principal)),
  PutSecretValue: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.putSecretValue(input);
  },
  RestoreSecret: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.restoreSecret(input);
  },
  TagResource: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.tagResource(input);
  },
  UntagResource: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.untagResource(input);
  },
  UpdateSecret: (store, input, principal) => {
    assertSecretAllowed(store, input, principal);
    return store.updateSecret(input);
  },
});

export const SUPPORTED_OPERATIONS = Object.freeze(Object.keys(HANDLERS).sort());

/**
 * Dispatch an AWS operation to the store.
 *
 * @param {string} operation
 * @param {unknown} input
 * @param {import("./store.mjs").SecretStore} store
 * @param {Principal|null} [principal]
 * @returns {Record<string, unknown>}
 */
export function dispatch(operation, input, store, principal = null) {
  if (
    typeof operation !== "string" ||
    !Object.prototype.hasOwnProperty.call(HANDLERS, operation)
  ) {
    throw unknownOperation(operation);
  }
  const payload = input === undefined || input === null ? {} : input;
  if (!isPlainObject(payload)) {
    throw invalidParameter("The request body must be a JSON object.");
  }
  return HANDLERS[operation](store, payload, principal);
}
