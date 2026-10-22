import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { resolveWordlistPath } from "./generator";
import { getSecretJson, secretsManagerEnabled } from "./secrets-manager";
import type { WordlistEnforcement } from "./runtime-config";

export type WordlistStatus = {
  state: "ok" | "mismatch" | "error" | "disabled";
  checked: boolean;
  enforcement: WordlistEnforcement;
  path: string;
  expected?: string;
  actual?: string;
  error?: string;
};

type DigestResult = {
  state: "ok" | "mismatch" | "error";
  expected?: string;
  actual?: string;
  error?: string;
};

const CACHE_MS = 60_000;

let digestCache: { value: DigestResult; expiresAt: number } | null = null;

function resetDigestCache(): void {
  digestCache = null;
}

async function computeDigestStatus(): Promise<DigestResult> {
  if (digestCache && digestCache.expiresAt > Date.now()) {
    return digestCache.value;
  }

  let value: DigestResult;
  const secretId = process.env.INTEGRITY_SECRET_ID?.trim();

  if (!secretId) {
    value = { state: "error", error: "INTEGRITY_SECRET_ID is not configured." };
  } else {
    const secret = await getSecretJson<{ wordlistSha256?: unknown }>(secretId);
    if (!secret.ok) {
      value = { state: "error", error: `Unable to read the integrity secret (${secret.code}).` };
    } else {
      const expected = String(secret.value?.wordlistSha256 ?? "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expected)) {
        value = { state: "error", error: "The integrity secret has no valid wordlistSha256." };
      } else {
        try {
          const bytes = await readFile(resolveWordlistPath());
          const actual = crypto.createHash("sha256").update(bytes).digest("hex");
          value =
            actual === expected
              ? { state: "ok", expected, actual }
              : { state: "mismatch", expected, actual };
        } catch (error) {
          value = {
            state: "error",
            error: error instanceof Error ? error.message : "Unable to read the word list.",
          };
        }
      }
    }
  }

  digestCache = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

/**
 * Verify the shared word list against the digest published in the Secrets
 * Manager. The expected digest lives outside the container image, so a
 * tampered word list is detectable.
 */
export async function verifyWordlist(
  enforcement: WordlistEnforcement = "warn",
): Promise<WordlistStatus> {
  const path = resolveWordlistPath();

  if (enforcement === "off" || !secretsManagerEnabled()) {
    return { state: "disabled", checked: false, enforcement, path };
  }

  const digest = await computeDigestStatus();
  return { ...digest, checked: true, enforcement, path };
}

export function resetWordlistCache(): void {
  resetDigestCache();
}
