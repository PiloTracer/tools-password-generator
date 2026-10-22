import { invalidParameter, unknownOperation } from "./errors.mjs";
import { isPlainObject } from "./util.mjs";

/**
 * AWS Secrets Manager operation -> SecretStore method.
 * The target name in the `X-Amz-Target` header selects one of these.
 */
const HANDLERS = Object.freeze({
  BatchGetSecretValue: (store, input) => store.batchGetSecretValue(input),
  CreateSecret: (store, input) => store.createSecret(input),
  DeleteSecret: (store, input) => store.deleteSecret(input),
  DescribeSecret: (store, input) => store.describeSecret(input),
  GetRandomPassword: (store, input) => store.getRandomPassword(input),
  GetSecretValue: (store, input) => store.getSecretValue(input),
  ListSecretVersionIds: (store, input) => store.listSecretVersionIds(input),
  ListSecrets: (store, input) => store.listSecrets(input),
  PutSecretValue: (store, input) => store.putSecretValue(input),
  RestoreSecret: (store, input) => store.restoreSecret(input),
  TagResource: (store, input) => store.tagResource(input),
  UntagResource: (store, input) => store.untagResource(input),
  UpdateSecret: (store, input) => store.updateSecret(input),
});

export const SUPPORTED_OPERATIONS = Object.freeze(Object.keys(HANDLERS).sort());

/**
 * Dispatch an AWS operation to the store.
 *
 * @param {string} operation
 * @param {unknown} input
 * @param {import("./store.mjs").SecretStore} store
 * @returns {Record<string, unknown>}
 */
export function dispatch(operation, input, store) {
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
  return HANDLERS[operation](store, payload);
}
