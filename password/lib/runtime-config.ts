import { coerceRequestsPerMinute, DEFAULT_REQUESTS_PER_MINUTE } from "./rate-limit";
import { getSecretJson, secretsManagerEnabled } from "./secrets-manager";

export type WordlistEnforcement = "off" | "warn" | "enforce";

export type RuntimeLimits = {
  lengthMin: number;
  lengthMax: number;
  specialCountMax: number;
  digitCountMax: number;
  mixedCaseCountMax: number;
  wordCountMin: number;
  wordCountMax: number;
  requestsPerMinute: number;
};

export type RuntimeFeatures = {
  characters: boolean;
  passphrase: boolean;
  qrCode: boolean;
  historySize: number;
};

export type RuntimeConfig = {
  source: "defaults" | "secretsmanager";
  environment: string;
  limits: RuntimeLimits;
  features: RuntimeFeatures;
  wordlist: { enforcement: WordlistEnforcement };
  fetchedAt: number;
  error?: string;
};

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  source: "defaults",
  environment: "unknown",
  limits: {
    lengthMin: 4,
    lengthMax: 256,
    specialCountMax: 64,
    digitCountMax: 64,
    mixedCaseCountMax: 128,
    wordCountMin: 2,
    wordCountMax: 16,
    requestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE,
  },
  features: {
    characters: true,
    passphrase: true,
    qrCode: true,
    historySize: 10,
  },
  wordlist: { enforcement: "off" },
  fetchedAt: 0,
};

let cachedConfig: { config: RuntimeConfig; expiresAt: number } | null = null;
let inflight: Promise<RuntimeConfig> | null = null;
let lastWarningAt = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseEnforcement(value: unknown, fallback: WordlistEnforcement): WordlistEnforcement {
  return value === "off" || value === "warn" || value === "enforce" ? value : fallback;
}

function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) {
    return;
  }
  lastWarningAt = now;
  console.warn(message);
}

function parseRuntimeConfig(raw: unknown, base: RuntimeConfig): RuntimeConfig {
  const root = isRecord(raw) ? raw : {};
  const limitsRaw = isRecord(root.limits) ? root.limits : {};
  const featuresRaw = isRecord(root.features) ? root.features : {};
  const wordlistRaw = isRecord(root.wordlist) ? root.wordlist : {};

  const limits: RuntimeLimits = {
    lengthMin: clampInteger(limitsRaw.lengthMin, base.limits.lengthMin, 1, 256),
    lengthMax: clampInteger(limitsRaw.lengthMax, base.limits.lengthMax, 1, 256),
    specialCountMax: clampInteger(limitsRaw.specialCountMax, base.limits.specialCountMax, 0, 256),
    digitCountMax: clampInteger(limitsRaw.digitCountMax, base.limits.digitCountMax, 0, 256),
    mixedCaseCountMax: clampInteger(
      limitsRaw.mixedCaseCountMax,
      base.limits.mixedCaseCountMax,
      0,
      256,
    ),
    wordCountMin: clampInteger(limitsRaw.wordCountMin, base.limits.wordCountMin, 1, 64),
    wordCountMax: clampInteger(limitsRaw.wordCountMax, base.limits.wordCountMax, 1, 64),
    requestsPerMinute: coerceRequestsPerMinute(
      limitsRaw.requestsPerMinute,
      base.limits.requestsPerMinute,
    ),
  };
  if (limits.lengthMax < limits.lengthMin) {
    limits.lengthMax = limits.lengthMin;
  }
  if (limits.wordCountMax < limits.wordCountMin) {
    limits.wordCountMax = limits.wordCountMin;
  }

  return {
    source: "secretsmanager",
    environment: base.environment,
    limits,
    features: {
      characters: parseBoolean(featuresRaw.characters, base.features.characters),
      passphrase: parseBoolean(featuresRaw.passphrase, base.features.passphrase),
      qrCode: parseBoolean(featuresRaw.qrCode, base.features.qrCode),
      historySize: clampInteger(featuresRaw.historySize, base.features.historySize, 0, 100),
    },
    wordlist: {
      enforcement: parseEnforcement(wordlistRaw.enforcement, base.wordlist.enforcement),
    },
    fetchedAt: Date.now(),
  };
}

function baseConfig(): RuntimeConfig {
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    environment: process.env.APP_ENV?.trim() || "unknown",
    limits: { ...DEFAULT_RUNTIME_CONFIG.limits },
    features: { ...DEFAULT_RUNTIME_CONFIG.features },
    wordlist: { ...DEFAULT_RUNTIME_CONFIG.wordlist },
    fetchedAt: Date.now(),
  };
}

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const base = baseConfig();

  if (!secretsManagerEnabled()) {
    return base;
  }

  const secretId = process.env.APP_CONFIG_SECRET_ID?.trim();
  if (!secretId) {
    return { ...base, error: "APP_CONFIG_SECRET_ID is not configured." };
  }

  const result = await getSecretJson<unknown>(secretId);
  if (!result.ok) {
    warnThrottled(
      `[runtime-config] unable to load '${secretId}' (${result.code}): ${result.error}. Using defaults.`,
    );
    return { ...base, error: result.error };
  }

  return parseRuntimeConfig(result.value, base);
}

/**
 * Resolve the runtime policy. The config is cached for SECRETS_CACHE_TTL_MS and
 * failures never break generation: the built-in defaults are used instead.
 */
export async function getRuntimeConfig(options: { force?: boolean } = {}): Promise<RuntimeConfig> {
  if (!options.force && cachedConfig && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.config;
  }
  if (inflight) {
    return inflight;
  }

  inflight = loadRuntimeConfig()
    .then((config) => {
      cachedConfig = {
        config,
        expiresAt: Date.now() + Math.min(600_000, Math.max(1_000, Number(process.env.SECRETS_CACHE_TTL_MS ?? 30_000) || 30_000)),
      };
      return config;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function resetRuntimeConfigCache(): void {
  cachedConfig = null;
  inflight = null;
}
