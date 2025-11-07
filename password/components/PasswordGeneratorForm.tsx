"use client";

import { FormEvent, useMemo, useState } from "react";

type Mode = "characters" | "words";

type CharacterFormState = {
  length: number;
  specialCount: number;
  digitCount: number;
  mixedCaseCount: number;
};

type PassphraseFormState = {
  wordCount: number;
  wordSeparator: string;
  passphraseDigitCount: number;
  passphraseSpecialCount: number;
  passphraseMixedCount: number;
  randomizeWordCapitalization: boolean;
};

const CHARACTER_LIMITS = {
  length: { min: 4, max: 256 },
  specialCount: { min: 0, max: 64 },
  digitCount: { min: 0, max: 64 },
  mixedCaseCount: { min: 0, max: 128 },
} as const;

const PASSPHRASE_LIMITS = {
  wordCount: { min: 2, max: 16 },
  passphraseDigitCount: { min: 0, max: 32 },
  passphraseSpecialCount: { min: 0, max: 32 },
  passphraseMixedCount: { min: 0, max: 64 },
} as const;

const CHARACTER_DEFAULTS: CharacterFormState = {
  length: 16,
  specialCount: 2,
  digitCount: 2,
  mixedCaseCount: 6,
};

const PASSPHRASE_DEFAULTS: PassphraseFormState = {
  wordCount: 4,
  wordSeparator: "-",
  passphraseDigitCount: 2,
  passphraseSpecialCount: 1,
  passphraseMixedCount: 2,
  randomizeWordCapitalization: true,
};

function clampValue(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function parseToInt(value: string, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

export function PasswordGeneratorForm() {
  const [mode, setMode] = useState<Mode>("characters");
  const [characterState, setCharacterState] = useState<CharacterFormState>(
    CHARACTER_DEFAULTS,
  );
  const [passphraseState, setPassphraseState] =
    useState<PassphraseFormState>(PASSPHRASE_DEFAULTS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const lowercaseFiller = useMemo(() => {
    if (mode !== "characters") {
      return 0;
    }
    return Math.max(
      0,
      characterState.length -
        (characterState.specialCount +
          characterState.digitCount +
          characterState.mixedCaseCount),
    );
  }, [mode, characterState]);

  const separatorWarning =
    mode === "words" && passphraseState.wordSeparator.trim() === ""
      ? "Words will be concatenated without a separator."
      : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setGeneratedPassword(null);
    setCopied(false);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "characters"
            ? { mode, ...characterState }
            : { mode, ...passphraseState },
        ),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(data?.error || "Failed to generate password.");
      }

      const data = (await response.json()) as { password: string };
      setGeneratedPassword(data.password);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unknown error.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!generatedPassword) return;
    try {
      await navigator.clipboard.writeText(generatedPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setErrorMessage("Unable to copy to clipboard.");
    }
  }

  return (
    <div className="w-full max-w-4xl rounded-3xl border border-white/10 bg-white/70 p-10 shadow-2xl backdrop-blur-md transition-colors dark:border-white/10 dark:bg-zinc-900/80">
      <header className="flex flex-wrap items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold text-zinc-900 dark:text-zinc-50">
            Secure Password Generator
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            Generate strong passwords or memorable passphrases using audited server-side
            logic. Your secrets never leave the server.
          </p>
        </div>
        <div className="flex gap-2 rounded-full border border-zinc-200 bg-white p-1 text-sm font-medium text-zinc-700 shadow-inner dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          <button
            type="button"
            className={`rounded-full px-4 py-1 transition ${
              mode === "characters"
                ? "bg-indigo-500 text-white shadow-sm"
                : "hover:text-indigo-500"
            }`}
            onClick={() => {
              setMode("characters");
              setGeneratedPassword(null);
              setErrorMessage(null);
            }}
          >
            Characters
          </button>
          <button
            type="button"
            className={`rounded-full px-4 py-1 transition ${
              mode === "words"
                ? "bg-indigo-500 text-white shadow-sm"
                : "hover:text-indigo-500"
            }`}
            onClick={() => {
              setMode("words");
              setGeneratedPassword(null);
              setErrorMessage(null);
            }}
          >
            Passphrase
          </button>
        </div>
      </header>

      <form className="mt-10 grid gap-8" onSubmit={handleSubmit}>
        {mode === "characters" ? (
          <section className="grid gap-6 md:grid-cols-2">
            <NumberInput
              label="Password length"
              description="Total number of characters in the generated password."
              value={characterState.length}
              min={CHARACTER_LIMITS.length.min}
              max={CHARACTER_LIMITS.length.max}
              onChange={(value) =>
                setCharacterState((prev) => ({
                  ...prev,
                  length: clampValue(
                    parseToInt(value, prev.length),
                    CHARACTER_LIMITS.length.min,
                    CHARACTER_LIMITS.length.max,
                  ),
                }))
              }
            />
            <NumberInput
              label="Special characters"
              description="Count of characters drawn from $ % ^ @ ! & *."
              value={characterState.specialCount}
              min={CHARACTER_LIMITS.specialCount.min}
              max={CHARACTER_LIMITS.specialCount.max}
              onChange={(value) =>
                setCharacterState((prev) => ({
                  ...prev,
                  specialCount: clampValue(
                    parseToInt(value, prev.specialCount),
                    CHARACTER_LIMITS.specialCount.min,
                    CHARACTER_LIMITS.specialCount.max,
                  ),
                }))
              }
            />
            <NumberInput
              label="Numbers"
              description="How many digits (0-9) should be included."
              value={characterState.digitCount}
              min={CHARACTER_LIMITS.digitCount.min}
              max={CHARACTER_LIMITS.digitCount.max}
              onChange={(value) =>
                setCharacterState((prev) => ({
                  ...prev,
                  digitCount: clampValue(
                    parseToInt(value, prev.digitCount),
                    CHARACTER_LIMITS.digitCount.min,
                    CHARACTER_LIMITS.digitCount.max,
                  ),
                }))
              }
            />
            <NumberInput
              label="Mixed-case letters"
              description="Number of letters randomly uppercased or lowercased."
              value={characterState.mixedCaseCount}
              min={CHARACTER_LIMITS.mixedCaseCount.min}
              max={CHARACTER_LIMITS.mixedCaseCount.max}
              onChange={(value) =>
                setCharacterState((prev) => ({
                  ...prev,
                  mixedCaseCount: clampValue(
                    parseToInt(value, prev.mixedCaseCount),
                    CHARACTER_LIMITS.mixedCaseCount.min,
                    CHARACTER_LIMITS.mixedCaseCount.max,
                  ),
                }))
              }
            />
            <div className="md:col-span-2 rounded-2xl bg-zinc-100 p-4 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              Lowercase filler characters:{" "}
              <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                {lowercaseFiller}
              </span>
            </div>
          </section>
        ) : (
          <section className="grid gap-6 md:grid-cols-2">
            <NumberInput
              label="Word count"
              description="How many words form the passphrase."
              value={passphraseState.wordCount}
              min={PASSPHRASE_LIMITS.wordCount.min}
              max={PASSPHRASE_LIMITS.wordCount.max}
              onChange={(value) =>
                setPassphraseState((prev) => ({
                  ...prev,
                  wordCount: clampValue(
                    parseToInt(value, prev.wordCount),
                    PASSPHRASE_LIMITS.wordCount.min,
                    PASSPHRASE_LIMITS.wordCount.max,
                  ),
                }))
              }
            />
            <TextInput
              label="Separator"
              description="Characters placed between words."
              value={passphraseState.wordSeparator}
              onChange={(value) =>
                setPassphraseState((prev) => ({
                  ...prev,
                  wordSeparator: value.slice(0, 5),
                }))
              }
            />
            <NumberInput
              label="Appended numbers"
              description="Digits attached to the end of the passphrase."
              value={passphraseState.passphraseDigitCount}
              min={PASSPHRASE_LIMITS.passphraseDigitCount.min}
              max={PASSPHRASE_LIMITS.passphraseDigitCount.max}
              onChange={(value) =>
                setPassphraseState((prev) => ({
                  ...prev,
                  passphraseDigitCount: clampValue(
                    parseToInt(value, prev.passphraseDigitCount),
                    PASSPHRASE_LIMITS.passphraseDigitCount.min,
                    PASSPHRASE_LIMITS.passphraseDigitCount.max,
                  ),
                }))
              }
            />
            <NumberInput
              label="Appended special characters"
              description="Each drawn from $ % ^ @ ! & *."
              value={passphraseState.passphraseSpecialCount}
              min={PASSPHRASE_LIMITS.passphraseSpecialCount.min}
              max={PASSPHRASE_LIMITS.passphraseSpecialCount.max}
              onChange={(value) =>
                setPassphraseState((prev) => ({
                  ...prev,
                  passphraseSpecialCount: clampValue(
                    parseToInt(value, prev.passphraseSpecialCount),
                    PASSPHRASE_LIMITS.passphraseSpecialCount.min,
                    PASSPHRASE_LIMITS.passphraseSpecialCount.max,
                  ),
                }))
              }
            />
            <NumberInput
              label="Appended mixed-case letters"
              description="Random letters toggled upper or lower case."
              value={passphraseState.passphraseMixedCount}
              min={PASSPHRASE_LIMITS.passphraseMixedCount.min}
              max={PASSPHRASE_LIMITS.passphraseMixedCount.max}
              onChange={(value) =>
                setPassphraseState((prev) => ({
                  ...prev,
                  passphraseMixedCount: clampValue(
                    parseToInt(value, prev.passphraseMixedCount),
                    PASSPHRASE_LIMITS.passphraseMixedCount.min,
                    PASSPHRASE_LIMITS.passphraseMixedCount.max,
                  ),
                }))
              }
            />
            <ToggleInput
              label="Randomize uppercase positions"
              description="Securely capitalizes a random letter inside each word."
              checked={passphraseState.randomizeWordCapitalization}
              onChange={(checked) =>
                setPassphraseState((prev) => ({
                  ...prev,
                  randomizeWordCapitalization: checked,
                }))
              }
            />
            {separatorWarning ? (
              <p className="md:col-span-2 rounded-2xl bg-amber-50 p-4 text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                {separatorWarning}
              </p>
            ) : null}
          </section>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-300/40 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-400"
          >
            {isSubmitting ? "Generating..." : "Generate password"}
          </button>
          {generatedPassword ? (
            <div className="flex items-center gap-3 rounded-full bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              <span className="truncate" title={generatedPassword}>
                {generatedPassword}
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="rounded-full border border-indigo-200 px-3 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-600 hover:text-white dark:border-indigo-500 dark:text-indigo-300 dark:hover:bg-indigo-500 dark:hover:text-white"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          ) : null}
        </div>

        {errorMessage ? (
          <p className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-600 dark:bg-rose-900/40 dark:text-rose-200">
            {errorMessage}
          </p>
        ) : null}
      </form>
    </div>
  );
}

type NumberInputProps = {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: string) => void;
};

function NumberInput({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: NumberInputProps) {
  return (
    <label className="flex flex-col gap-2 rounded-2xl border border-zinc-200 bg-white/80 p-4 shadow-sm transition hover:border-indigo-200 focus-within:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900/70 dark:hover:border-indigo-500">
      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {label}
      </span>
      {description ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {description}
        </span>
      ) : null}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-indigo-400"
      />
    </label>
  );
}

type TextInputProps = {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
};

function TextInput({ label, description, value, onChange }: TextInputProps) {
  return (
    <label className="flex flex-col gap-2 rounded-2xl border border-zinc-200 bg-white/80 p-4 shadow-sm transition hover:border-indigo-200 focus-within:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900/70 dark:hover:border-indigo-500">
      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {label}
      </span>
      {description ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {description}
        </span>
      ) : null}
      <input
        type="text"
        maxLength={5}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-indigo-400"
      />
    </label>
  );
}

type ToggleInputProps = {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

function ToggleInput({ label, description, checked, onChange }: ToggleInputProps) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-zinc-200 bg-white/80 p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/70">
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {label}
          </span>
          {description ? (
            <p className="mt-1 max-w-xs text-xs text-zinc-500 dark:text-zinc-400">
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onChange(!checked)}
          className={`relative h-7 w-12 rounded-full transition ${
            checked
              ? "bg-indigo-500 shadow-inner shadow-indigo-200"
              : "bg-zinc-300 dark:bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white transition-transform ${
              checked ? "translate-x-6" : "translate-x-1"
            }`}
          />
          <span className="sr-only">{label}</span>
        </button>
      </div>
    </div>
  );
}
