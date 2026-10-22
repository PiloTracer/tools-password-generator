/**
 * Error type that maps directly onto the AWS JSON 1.1 error envelope:
 *
 *   HTTP 400
 *   {"__type":"ResourceNotFoundException","message":"..."}
 *
 * The AWS SDKs and the `aws` CLI surface `type` as the error code, so keeping
 * these names faithful is what makes this endpoint protocol compatible.
 */
export class AwsError extends Error {
  /**
   * @param {string} type
   * @param {string} message
   * @param {number} [status]
   */
  constructor(type, message, status = 400) {
    super(message);
    this.name = type;
    this.type = type;
    this.status = status;
  }
}

/**
 * @param {string} type
 * @param {string} message
 * @param {number} [status]
 */
export function awsError(type, message, status = 400) {
  return new AwsError(type, message, status);
}

export function resourceNotFound() {
  return new AwsError(
    "ResourceNotFoundException",
    "Secrets Manager can't find the specified secret.",
  );
}

export function resourceExists() {
  return new AwsError(
    "ResourceExistsException",
    "The operation failed because the secret already exists.",
  );
}

export function invalidParameter(message) {
  return new AwsError("InvalidParameterException", message);
}

export function invalidRequest(message) {
  return new AwsError("InvalidRequestException", message);
}

export function accessDenied(message = "User is not authorized to perform the requested operation.") {
  return new AwsError("AccessDeniedException", message);
}

export function missingAuthenticationToken() {
  return new AwsError(
    "MissingAuthenticationTokenException",
    "Request is missing Authentication Token",
  );
}

export function unrecognizedClient() {
  return new AwsError(
    "UnrecognizedClientException",
    "The security token included in the request is invalid.",
  );
}

export function invalidSignature(message = "The request signature we calculated does not match the signature you provided.") {
  return new AwsError("InvalidSignatureException", message, 403);
}

export function requestExpired() {
  return new AwsError("RequestExpired", "Request has expired.");
}

export function xAmzContentSha256Mismatch() {
  return new AwsError(
    "XAmzContentSHA256Mismatch",
    "The provided 'x-amz-content-sha256' header does not match what was computed.",
  );
}

export function serializationError(message = "Invalid JSON request body.") {
  return new AwsError("SerializationException", message);
}

export function unknownOperation(operation) {
  return new AwsError(
    "UnknownOperationException",
    `Unknown operation: ${operation || "(missing x-amz-target)"}`,
  );
}

export function internalError() {
  return new AwsError(
    "InternalServiceError",
    "An error occurred on the server side.",
    500,
  );
}
