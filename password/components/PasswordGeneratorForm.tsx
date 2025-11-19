"use client";

import { FormEvent, useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import zxcvbn from "zxcvbn";
import { Copy, Check, RefreshCw, History, Download, QrCode, X, AlertTriangle } from "lucide-react";
import clsx from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

type Mode = "characters" | "words";

type CharacterFormState = {
  length: number;
  specialCount: number;
  digitCount: number;
  mixedCaseCount: number;
  excludeAmbiguous: boolean;
};

type PassphraseFormState = {
  wordCount: number;
  wordSeparator: string;
  passphraseDigitCount: number;
  passphraseSpecialCount: number;
  passphraseMixedCount: number;
  randomizeWordCapitalization: boolean;
  excludeAmbiguous: boolean;
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
  excludeAmbiguous: false,
};

const PASSPHRASE_DEFAULTS: PassphraseFormState = {
  wordCount: 4,
  wordSeparator: "-",
  passphraseDigitCount: 2,
  passphraseSpecialCount: 1,
  passphraseMixedCount: 2,
  randomizeWordCapitalization: true,
  excludeAmbiguous: false,
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
  const [characterState, setCharacterState] = useState<CharacterFormState>(CHARACTER_DEFAULTS);
  const [passphraseState, setPassphraseState] = useState<PassphraseFormState>(PASSPHRASE_DEFAULTS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [passwordHistory, setPasswordHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showQR, setShowQR] = useState(false);

  // Load history from session storage
  useEffect(() => {
    const stored = sessionStorage.getItem("passwordHistory");
    if (stored) {
      try {
        setPasswordHistory(JSON.parse(stored));
      } catch {
        // ignore
      }
    }
  }, []);

  // Save history to session storage
  useEffect(() => {
    sessionStorage.setItem("passwordHistory", JSON.stringify(passwordHistory));
  }, [passwordHistory]);

  const strength = useMemo(() => {
    if (!generatedPassword) return null;
    return zxcvbn(generatedPassword);
  }, [generatedPassword]);

  const strengthColor = useMemo(() => {
    if (!strength) return "bg-zinc-200 dark:bg-zinc-700";
    switch (strength.score) {
      case 0:
      case 1:
        return "bg-red-500";
      case 2:
        return "bg-orange-500";
      case 3:
        return "bg-yellow-500";
      case 4:
        return "bg-green-500";
      default:
        return "bg-zinc-200 dark:bg-zinc-700";
    }
  }, [strength]);

  const strengthLabel = useMemo(() => {
    if (!strength) return "";
    const labels = ["Very Weak", "Weak", "Fair", "Strong", "Very Strong"];
    return labels[strength.score];
  }, [strength]);

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
    setShowQR(false);

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
      setPasswordHistory((prev) => [data.password, ...prev].slice(0, 10));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unknown error.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCopy(text: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setErrorMessage("Unable to copy to clipboard.");
    }
  }

  function handleExport() {
    if (!generatedPassword) return;
    const blob = new Blob([generatedPassword], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "password.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="glass-card w-full max-w-4xl p-8 md:p-12 transition-all duration-500">
      <header className="flex flex-wrap items-center justify-between gap-6 mb-10">
        <div>
          <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-600 dark:from-indigo-400 dark:to-purple-400">
            Secure Password Generator
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Generate strong passwords or memorable passphrases using audited server-side
            logic. Your secrets never leave the server, your secrets are never stored anywhere.
          </p>
        </div>
        <div className="flex gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-800/50 backdrop-blur-sm">
          <button
            type="button"
            className={cn(
              "rounded-full px-6 py-2 text-sm font-medium transition-all duration-300",
              mode === "characters"
                ? "bg-white text-indigo-600 shadow-md dark:bg-zinc-700 dark:text-indigo-300"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            )}
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
            className={cn(
              "rounded-full px-6 py-2 text-sm font-medium transition-all duration-300",
              mode === "words"
                ? "bg-white text-indigo-600 shadow-md dark:bg-zinc-700 dark:text-indigo-300"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            )}
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

      <form className="grid gap-8" onSubmit={handleSubmit}>
        <AnimatePresence mode="wait">
          {mode === "characters" ? (
            <motion.section
              key="characters"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
              className="grid gap-6 md:grid-cols-2"
            >
              <NumberInput
                label="Password length"
                description="Total characters"
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
                description="$ % ^ @ ! & *"
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
                description="Digits 0-9"
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
                description="Random upper/lower"
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
              <div className="md:col-span-2 flex items-center justify-between p-4 rounded-2xl bg-zinc-50/50 border border-zinc-100 dark:bg-zinc-800/30 dark:border-zinc-700/50">
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  Lowercase filler characters
                </span>
                <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400 text-lg">
                  {lowercaseFiller}
                </span>
              </div>
              <div className="md:col-span-2">
                <ToggleInput
                  label="Exclude Ambiguous Characters"
                  description="Avoid confusing characters like l, 1, I, O, 0"
                  checked={characterState.excludeAmbiguous}
                  onChange={(checked) =>
                    setCharacterState((prev) => ({ ...prev, excludeAmbiguous: checked }))
                  }
                />
              </div>
            </motion.section>
          ) : (
            <motion.section
              key="words"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
              className="grid gap-6 md:grid-cols-2"
            >
              <NumberInput
                label="Word count"
                description="Words in passphrase"
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
                description="Between words"
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
                description="Digits at end"
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
                label="Appended specials"
                description="$ % ^ @ ! & *"
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
                label="Appended mixed-case"
                description="Random letters"
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
                label="Randomize capitalization"
                description="One upper per word"
                checked={passphraseState.randomizeWordCapitalization}
                onChange={(checked) =>
                  setPassphraseState((prev) => ({
                    ...prev,
                    randomizeWordCapitalization: checked,
                  }))
                }
              />
              <div className="md:col-span-2">
                <ToggleInput
                  label="Exclude Ambiguous Characters"
                  description="Avoid confusing characters in appended suffix"
                  checked={passphraseState.excludeAmbiguous}
                  onChange={(checked) =>
                    setPassphraseState((prev) => ({ ...prev, excludeAmbiguous: checked }))
                  }
                />
              </div>
              {separatorWarning ? (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="md:col-span-2 rounded-2xl bg-amber-50 p-4 text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 flex items-center gap-2"
                >
                  <AlertTriangle size={16} />
                  {separatorWarning}
                </motion.p>
              ) : null}
            </motion.section>
          )}
        </AnimatePresence>

        <div className="flex flex-col gap-6">
          <button
            type="submit"
            disabled={isSubmitting}
            className="group relative flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 to-purple-600 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-indigo-500/30 transition-all hover:scale-[1.02] hover:shadow-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSubmitting ? (
              <RefreshCw className="animate-spin" />
            ) : (
              <RefreshCw className="transition-transform group-hover:rotate-180" />
            )}
            {isSubmitting ? "Generating..." : "Generate Password"}
          </button>

          <AnimatePresence>
            {generatedPassword && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="rounded-3xl bg-zinc-50 p-6 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700"
              >
                <div className="flex flex-col gap-4">
                  <div className="relative group">
                    <div className="break-all font-mono text-2xl text-zinc-800 dark:text-zinc-100 p-4 text-center">
                      {generatedPassword}
                    </div>
                    <div className="flex justify-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      {/* Actions overlay or just below */}
                    </div>
                  </div>

                  {/* Strength Meter */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400">
                      <span>Strength</span>
                      <span>{strengthLabel}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                      <motion.div
                        className={`h-full ${strengthColor}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${((strength?.score || 0) + 1) * 20}%` }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>
                    {strength?.feedback?.warning && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                        {strength.feedback.warning}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-center gap-3 mt-2">
                    <button
                      type="button"
                      onClick={() => handleCopy(generatedPassword)}
                      className="flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-700 shadow-sm ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:bg-zinc-700 dark:text-zinc-200 dark:ring-zinc-600 dark:hover:bg-zinc-600"
                    >
                      {copied ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowQR(!showQR)}
                      className="flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-700 shadow-sm ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:bg-zinc-700 dark:text-zinc-200 dark:ring-zinc-600 dark:hover:bg-zinc-600"
                    >
                      <QrCode size={16} />
                      QR Code
                    </button>
                    <button
                      type="button"
                      onClick={handleExport}
                      className="flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-700 shadow-sm ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:bg-zinc-700 dark:text-zinc-200 dark:ring-zinc-600 dark:hover:bg-zinc-600"
                    >
                      <Download size={16} />
                      Export
                    </button>
                  </div>

                  <AnimatePresence>
                    {showQR && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="flex justify-center pt-4 overflow-hidden"
                      >
                        <div className="p-4 bg-white rounded-xl shadow-inner">
                          <QRCodeSVG value={generatedPassword} size={160} />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* History Section */}
        <div className="border-t border-zinc-200 pt-8 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-2 text-sm font-medium text-zinc-500 transition hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <History size={16} />
            {showHistory ? "Hide History" : "Show History"}
          </button>

          <AnimatePresence>
            {showHistory && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mt-4 space-y-2 overflow-hidden"
              >
                {passwordHistory.length === 0 ? (
                  <p className="text-xs text-zinc-400 italic">No history yet.</p>
                ) : (
                  passwordHistory.map((pwd, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50"
                    >
                      <span className="truncate font-mono text-zinc-600 dark:text-zinc-300 max-w-[200px] md:max-w-md">
                        {pwd}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy(pwd)}
                        className="ml-2 text-zinc-400 hover:text-indigo-500 transition"
                        title="Copy"
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                  ))
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {errorMessage ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-600 dark:bg-rose-900/40 dark:text-rose-200 flex items-center gap-2"
          >
            <AlertTriangle size={16} />
            {errorMessage}
          </motion.div>
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
    <label className="glass-input flex flex-col gap-2 rounded-2xl p-4 shadow-sm transition-all hover:shadow-md">
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
        className="mt-1 rounded-xl border border-zinc-200 bg-white/50 px-3 py-2 text-sm font-medium text-zinc-900 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-100 dark:focus:border-indigo-400 transition-all"
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
    <label className="glass-input flex flex-col gap-2 rounded-2xl p-4 shadow-sm transition-all hover:shadow-md">
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
        className="mt-1 rounded-xl border border-zinc-200 bg-white/50 px-3 py-2 text-sm font-medium text-zinc-900 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-100 dark:focus:border-indigo-400 transition-all"
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
    <div className="glass-input flex flex-col gap-2 rounded-2xl p-4 shadow-sm transition-all hover:shadow-md">
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
          className={cn(
            "relative h-7 w-12 rounded-full transition-colors duration-300",
            checked
              ? "bg-indigo-500 shadow-inner shadow-indigo-200"
              : "bg-zinc-300 dark:bg-zinc-700"
          )}
        >
          <span
            className={cn(
              "absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-300",
              checked ? "translate-x-6" : "translate-x-1"
            )}
          />
          <span className="sr-only">{label}</span>
        </button>
      </div>
    </div>
  );
}
