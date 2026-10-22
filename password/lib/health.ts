import { checkGeneratorHealth, type GeneratorHealth } from "./generator";
import { getRuntimeConfig, type RuntimeConfig } from "./runtime-config";
import { secretsManagerEnabled } from "./secrets-manager";
import { verifyWordlist, type WordlistStatus } from "./wordlist";

export type SecretsManagerHealth = {
  status: "ok" | "degraded" | "disabled";
  source: "secretsmanager" | "defaults";
  error?: string;
};

export type HealthReport = {
  status: "ok" | "degraded" | "error";
  ready: boolean;
  environment: string;
  version: string;
  uptimeSeconds: number;
  checkedAt: string;
  checks: {
    generator: GeneratorHealth;
    secretsManager: SecretsManagerHealth;
    wordlist: WordlistStatus;
  };
  policy: {
    characters: boolean;
    passphrase: boolean;
    requestsPerMinute: number;
  };
};

/**
 * Collect the health of every dependency. Generation only requires Python and
 * the shared script; the Secrets Manager is an optional policy source, so an
 * outage degrades the report instead of failing the readiness probe.
 */
export async function collectHealth(): Promise<HealthReport> {
  const generatorPromise = checkGeneratorHealth();
  const config: RuntimeConfig = await getRuntimeConfig();
  const [generator, wordlist] = await Promise.all([
    generatorPromise,
    verifyWordlist(config.wordlist.enforcement),
  ]);

  const enabled = secretsManagerEnabled();
  const secretsStatus: SecretsManagerHealth = !enabled
    ? { status: "disabled", source: "defaults" }
    : config.source === "secretsmanager"
      ? { status: "ok", source: "secretsmanager" }
      : {
          status: "degraded",
          source: "defaults",
          ...(config.error ? { error: config.error } : {}),
        };

  const wordlistUnhealthy = wordlist.state === "mismatch" || wordlist.state === "error";
  const enforcedFailure =
    config.wordlist.enforcement === "enforce" && wordlist.state !== "ok";

  const status = !generator.ok || enforcedFailure
    ? "error"
    : secretsStatus.status === "degraded" ||
        (wordlistUnhealthy && config.wordlist.enforcement !== "off")
      ? "degraded"
      : "ok";

  return {
    status,
    ready: status !== "error" && secretsStatus.status !== "degraded",
    environment: process.env.APP_ENV?.trim() || "unknown",
    version: process.env.APP_VERSION?.trim() || "unknown",
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    checks: {
      generator,
      secretsManager: secretsStatus,
      wordlist,
    },
    policy: {
      characters: config.features.characters,
      passphrase: config.features.passphrase,
      requestsPerMinute: config.limits.requestsPerMinute,
    },
  };
}
