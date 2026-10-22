/**
 * Minimal AWS SDK v3 client for the AWS-compatible Secrets Manager.
 *
 * This is the same code an external application would run. Install the SDK
 * in your application and point the client at the endpoint:
 *
 *   npm install @aws-sdk/client-secrets-manager
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *     SM_ENDPOINT=http://127.0.0.1:18001 \
 *     node aws-sdk-v3.mjs
 *
 * Inside the Compose network use SM_ENDPOINT=http://secrets-manager:8080.
 * The client never prints secret values; it only reports metadata.
 */
import {
  GetSecretValueCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const endpoint = process.env.SM_ENDPOINT || "http://127.0.0.1:18001";
const region = process.env.AWS_REGION || "us-east-1";
const environment = process.env.APP_ENV || "dev";
const secretId =
  process.env.SM_POLICY_SECRET_ID ||
  `password-generator/${environment}/app-config`;

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

if (!accessKeyId || !secretAccessKey) {
  console.error(
    "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or source .env.dev).",
  );
  process.exit(2);
}

const client = new SecretsManagerClient({
  region,
  endpoint,
  credentials: {
    accessKeyId,
    secretAccessKey,
    ...(process.env.AWS_SESSION_TOKEN
      ? { sessionToken: process.env.AWS_SESSION_TOKEN }
      : {}),
  },
});

try {
  const listed = await client.send(new ListSecretsCommand({}));
  const names = (listed.SecretList || []).map((secret) => secret.Name);
  console.log(`ListSecrets: ${names.length} secret(s)`);

  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const policy = JSON.parse(result.SecretString);
  console.log(`GetSecretValue: ${secretId}`);
  console.log(`  policy environment: ${policy.environment}`);
  console.log(`  policy version:     ${policy.schemaVersion}`);
  console.log("AWS SDK v3 client OK");
} catch (error) {
  console.error(
    `AWS SDK v3 request failed [${error.name || "Error"}]: ${error.message}`,
  );
  process.exit(1);
}
