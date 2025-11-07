import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "node:path";

export const runtime = "nodejs";

type CharacterPayload = {
  mode: "characters";
  length?: number;
  specialCount?: number;
  digitCount?: number;
  mixedCaseCount?: number;
};

type PassphrasePayload = {
  mode: "words";
  wordCount?: number;
  wordSeparator?: string;
  passphraseDigitCount?: number;
  passphraseSpecialCount?: number;
  passphraseMixedCount?: number;
  randomizeWordCapitalization?: boolean;
};

type Payload = (CharacterPayload | PassphrasePayload) & {
  requestId?: string;
};

const LIMITS = {
  length: { min: 4, max: 256, default: 16 },
  specialCount: { min: 0, max: 64, default: 2 },
  digitCount: { min: 0, max: 64, default: 2 },
  mixedCaseCount: { min: 0, max: 128, default: 6 },
  wordCount: { min: 2, max: 16, default: 4 },
  passphraseDigitCount: { min: 0, max: 32, default: 2 },
  passphraseSpecialCount: { min: 0, max: 32, default: 1 },
  passphraseMixedCount: { min: 0, max: 64, default: 2 },
};

const SAFE_SEPARATOR_REGEX = /^[\w\-_.:|~]{0,5}$/;

function sanitizeNumber(
  raw: unknown,
  key:
    | "length"
    | "specialCount"
    | "digitCount"
    | "mixedCaseCount"
    | "wordCount"
    | "passphraseDigitCount"
    | "passphraseSpecialCount"
    | "passphraseMixedCount",
): number {
  const limits = LIMITS[key];
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return clamp(raw, limits.min, limits.max);
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed)) {
      return clamp(parsed, limits.min, limits.max);
    }
  }
  return limits.default;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.max(min, Math.min(value, max));
}

function sanitizeSeparator(raw: unknown): string {
  if (typeof raw !== "string") {
    return "-";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "-";
  }
  if (!SAFE_SEPARATOR_REGEX.test(trimmed)) {
    return "-";
  }
  return trimmed;
}

function sanitizeBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return fallback;
}

async function invokePython(args: string[]): Promise<string> {
  const scriptPath = path.resolve(process.cwd(), "..", "password_generator.py");
  const finalArgs = [scriptPath, "--non-interactive", ...args];

  return new Promise((resolve, reject) => {
    const child = spawn("python", finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (code === 0) {
        const lines = stdout.trim().split(/\r?\n/);
        const lastLine = lines.reverse().find((line) => line.trim().length > 0);
        if (!lastLine) {
          reject(new Error("Password generator produced no output."));
          return;
        }
        resolve(lastLine.trim());
      } else {
        reject(new Error(stderr.trim() || "Password generator failed."));
      }
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

export async function POST(request: NextRequest) {
  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const mode = payload.mode === "words" ? "words" : "characters";
  const args: string[] = [];

  if (mode === "characters") {
    const characterPayload = payload as CharacterPayload;
    const length = sanitizeNumber(characterPayload.length, "length");
    const specialCount = sanitizeNumber(characterPayload.specialCount, "specialCount");
    const digitCount = sanitizeNumber(characterPayload.digitCount, "digitCount");
    const mixedCaseCount = sanitizeNumber(
      characterPayload.mixedCaseCount,
      "mixedCaseCount",
    );

    if (specialCount + digitCount + mixedCaseCount > length) {
      return NextResponse.json(
        { error: "Sum of selected character counts cannot exceed total length." },
        { status: 400 },
      );
    }

    args.push("--length", String(length));
    args.push("--special-count", String(specialCount));
    args.push("--digit-count", String(digitCount));
    args.push("--mixed-case-count", String(mixedCaseCount));
  } else {
    const passphrasePayload = payload as PassphrasePayload;
    const wordCount = sanitizeNumber(passphrasePayload.wordCount, "wordCount");
    const passphraseDigitCount = sanitizeNumber(
      passphrasePayload.passphraseDigitCount,
      "passphraseDigitCount",
    );
    const passphraseSpecialCount = sanitizeNumber(
      passphrasePayload.passphraseSpecialCount,
      "passphraseSpecialCount",
    );
    const passphraseMixedCount = sanitizeNumber(
      passphrasePayload.passphraseMixedCount,
      "passphraseMixedCount",
    );
    const randomizeWordCapitalization = sanitizeBoolean(
      passphrasePayload.randomizeWordCapitalization,
      true,
    );
    const separator = sanitizeSeparator(passphrasePayload.wordSeparator);

    args.push("--use-words");
    args.push("--word-count", String(wordCount));
    args.push("--word-separator", separator);
    args.push("--passphrase-digit-count", String(passphraseDigitCount));
    args.push("--passphrase-special-count", String(passphraseSpecialCount));
    args.push("--passphrase-mixed-count", String(passphraseMixedCount));

    if (randomizeWordCapitalization) {
      args.push("--randomize-word-case");
    } else {
      args.push("--no-randomize-word-case");
    }
  }

  try {
    const password = await invokePython(args);
    return NextResponse.json({ password });
  } catch (error) {
    console.error("Password generation failed", error);
    return NextResponse.json(
      { error: "Unable to generate password at this time." },
      { status: 500 },
    );
  }
}
