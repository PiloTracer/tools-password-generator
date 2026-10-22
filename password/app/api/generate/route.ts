import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { runGenerator } from "@/lib/generator";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { verifyWordlist } from "@/lib/wordlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_SEPARATOR_REGEX = /^[\w\-_.:|~]{0,5}$/;

function toInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function numberWithin(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = toInteger(value);
  if (parsed === undefined) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function sanitizeSeparator(value: unknown): string {
  if (typeof value !== "string") {
    return "-";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "-";
  }
  if (!SAFE_SEPARATOR_REGEX.test(trimmed)) {
    return "-";
  }
  return trimmed;
}

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp || "unknown";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const respond = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): NextResponse =>
    NextResponse.json(body, {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
        ...headers,
      },
    });

  const config = await getRuntimeConfig();
  const rate = checkRateLimit(
    `generate:${clientKey(request)}`,
    config.limits.requestsPerMinute,
  );
  if (!rate.allowed) {
    return respond(
      { error: "Too many requests. Please wait a moment and try again." },
      429,
      { "Retry-After": String(rate.retryAfterSeconds) },
    );
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return respond({ error: "Invalid JSON body." }, 400);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return respond({ error: "Invalid JSON body." }, 400);
  }

  const mode = payload.mode === "words" ? "words" : "characters";
  if (mode === "characters" && !config.features.characters) {
    return respond({ error: "Character password generation is disabled by policy." }, 403);
  }
  if (mode === "words" && !config.features.passphrase) {
    return respond({ error: "Passphrase generation is disabled by policy." }, 403);
  }

  const args: string[] = [];
  if (booleanValue(payload.excludeAmbiguous, false)) {
    args.push("--exclude-ambiguous");
  }

  let expectedLength: number | null = null;

  if (mode === "characters") {
    const length = numberWithin(
      payload.length,
      config.limits.lengthMin,
      config.limits.lengthMax,
      16,
    );
    const specialCount = numberWithin(
      payload.specialCount,
      0,
      config.limits.specialCountMax,
      2,
    );
    const digitCount = numberWithin(payload.digitCount, 0, config.limits.digitCountMax, 2);
    const mixedCaseCount = numberWithin(
      payload.mixedCaseCount,
      0,
      config.limits.mixedCaseCountMax,
      6,
    );

    if (specialCount + digitCount + mixedCaseCount > length) {
      return respond(
        {
          error:
            "The sum of special, digit and mixed-case counts cannot exceed the total length.",
        },
        400,
      );
    }

    args.push(
      "--length",
      String(length),
      "--special-count",
      String(specialCount),
      "--digit-count",
      String(digitCount),
      "--mixed-case-count",
      String(mixedCaseCount),
    );
    expectedLength = length;
  } else {
    const wordCount = numberWithin(
      payload.wordCount,
      config.limits.wordCountMin,
      config.limits.wordCountMax,
      4,
    );
    const passphraseDigitCount = numberWithin(payload.passphraseDigitCount, 0, 32, 2);
    const passphraseSpecialCount = numberWithin(payload.passphraseSpecialCount, 0, 32, 1);
    const passphraseMixedCount = numberWithin(
      payload.passphraseMixedCount,
      0,
      config.limits.mixedCaseCountMax,
      2,
    );
    const separator = sanitizeSeparator(payload.wordSeparator);
    const randomize = booleanValue(payload.randomizeWordCapitalization, true);

    args.push(
      "--use-words",
      "--word-count",
      String(wordCount),
      "--word-separator",
      separator,
      "--passphrase-digit-count",
      String(passphraseDigitCount),
      "--passphrase-special-count",
      String(passphraseSpecialCount),
      "--passphrase-mixed-count",
      String(passphraseMixedCount),
    );
    args.push(randomize ? "--randomize-word-case" : "--no-randomize-word-case");

    if (config.wordlist.enforcement !== "off") {
      const wordlist = await verifyWordlist(config.wordlist.enforcement);
      if (wordlist.state === "mismatch" || wordlist.state === "error") {
        if (config.wordlist.enforcement === "enforce") {
          return respond(
            {
              error:
                "Passphrase generation is temporarily unavailable because the word list failed its integrity check.",
            },
            503,
          );
        }
        console.warn(
          `[generate] word list integrity check failed (${wordlist.state}): ${
            wordlist.error ?? "SHA-256 mismatch"
          }`,
        );
      }
    }
  }

  const result = await runGenerator(args, 10_000);
  if (!result.ok) {
    console.error("[generate] generator failure", {
      code: result.code,
      message: result.message,
    });
    return respond({ error: "Unable to generate a password at this time." }, 500);
  }

  const password = result.password;
  if (!/^[\x20-\x7E]+$/.test(password)) {
    console.error("[generate] generator returned non-printable output");
    return respond({ error: "Unable to generate a password at this time." }, 500);
  }
  if (expectedLength !== null && password.length !== expectedLength) {
    console.error("[generate] generator length mismatch", {
      expected: expectedLength,
      actual: password.length,
    });
    return respond({ error: "Unable to generate a password at this time." }, 500);
  }

  return respond({
    password,
    meta: {
      mode,
      length: password.length,
      source: config.source,
      requestId,
    },
  });
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Method not allowed. Use POST." },
    {
      status: 405,
      headers: {
        Allow: "POST",
        "Cache-Control": "no-store",
      },
    },
  );
}
