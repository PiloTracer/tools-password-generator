import { spawn, type ChildProcess } from "node:child_process";

import { releaseSlot, tryAcquireSlot } from "./concurrency";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export type GeneratorRunResult =
  | { ok: true; password: string }
  | { ok: false; code: string; message: string };

export type GeneratorHealth = {
  ok: boolean;
  python: string;
  script: string;
  error?: string;
};

const MAX_OUTPUT_BYTES = 64 * 1024;
const HEALTH_CACHE_MS = 60_000;

/**
 * Environment variables the Python child may inherit.
 *
 * The parent holds the Secrets Manager credential. Passing it — or PYTHONPATH /
 * PYTHONSTARTUP, both of which can inject code — into the most exposed
 * subprocess turns an interpreter quirk into a credential leak.
 */
const INHERITED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ", "HOME", "SYSTEMROOT"] as const;

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Node's ProcessEnv type declares NODE_ENV as required; it is not a secret
    // and the Python child ignores it.
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

let healthCache: { value: GeneratorHealth; expiresAt: number } | null = null;
let healthInflight: Promise<GeneratorHealth> | null = null;

/**
 * The Python interpreter to execute. Inside the images `python3` is always
 * available; on Windows the launcher is `python`.
 */
export function resolvePythonBin(): string {
  const configured = process.env.PYTHON_BIN?.trim();
  if (configured) {
    return configured;
  }
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * The shared generator script. PASSWORD_GENERATOR_SCRIPT is set by Compose;
 * the fallbacks keep `npm run dev` and the standalone server working too.
 */
export function resolveGeneratorScript(): string {
  const configured = process.env.PASSWORD_GENERATOR_SCRIPT?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const candidates = [
    path.resolve(process.cwd(), "..", "password_generator.py"),
    path.resolve(process.cwd(), "password_generator.py"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * The shared EFF word list, used for the integrity check.
 */
export function resolveWordlistPath(): string {
  const configured = process.env.WORDLIST_PATH?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const candidates = [
    path.resolve(process.cwd(), "..", "eff_short_wordlist_1.txt"),
    path.resolve(process.cwd(), "eff_short_wordlist_1.txt"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Execute password_generator.py with a strict timeout and output cap.
 *
 * The CLI prints an informational block before the password; the last
 * non-empty line is the generated value. Anything that looks like a CLI error
 * is rejected instead of being returned as a password.
 */
export async function runGenerator(
  args: string[],
  timeoutMs = 10_000,
): Promise<GeneratorRunResult> {
  const script = resolveGeneratorScript();
  try {
    await access(script);
  } catch {
    return {
      ok: false,
      code: "SCRIPT_NOT_FOUND",
      message: `The generator script is not readable at ${script}.`,
    };
  }

  const python = resolvePythonBin();

  if (!tryAcquireSlot()) {
    return {
      ok: false,
      code: "BUSY",
      message: "The generator is at capacity. Please retry in a moment.",
    };
  }

  return new Promise<GeneratorRunResult>((resolve) => {
    let settled = false;
    let guard: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: GeneratorRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      releaseSlot();
      if (guard) {
        clearTimeout(guard);
      }
      resolve(result);
    };

    try {
      const child: ChildProcess = spawn(python, [script, "--non-interactive", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv(),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let bytes = 0;

      guard = setTimeout(() => {
        child.kill("SIGKILL");
        settle({ ok: false, code: "TIMEOUT", message: "The generator timed out." });
      }, timeoutMs + 1_000);

      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          settle({
            ok: false,
            code: "OUTPUT_TOO_LARGE",
            message: "The generator produced more output than expected.",
          });
          return;
        }
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += chunk.toString("utf8");
        }
      });

      child.on("error", (error) => {
        settle({
          ok: false,
          code: "SPAWN_FAILED",
          message: `Unable to start ${python}: ${error.message}`,
        });
      });

      child.on("close", (code, signal) => {
        if (code !== 0) {
          settle({
            ok: false,
            code: "GENERATOR_FAILED",
            message: stderr.trim() || `The generator exited with code ${code ?? signal}.`,
          });
          return;
        }
        const lines = stdout
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0);
        const candidate = lines.length > 0 ? lines[lines.length - 1].trim() : "";
        if (!candidate) {
          settle({ ok: false, code: "EMPTY_OUTPUT", message: "The generator produced no output." });
          return;
        }
        if (/^(error|usage)\b/i.test(candidate) || /\bError:/.test(candidate)) {
          settle({ ok: false, code: "GENERATOR_ERROR", message: candidate });
          return;
        }
        settle({ ok: true, password: candidate });
      });
    } catch (error) {
      settle({
        ok: false,
        code: "SPAWN_FAILED",
        message: error instanceof Error ? error.message : "Unable to start the generator.",
      });
    }
  });
}

async function probeGenerator(): Promise<GeneratorHealth> {
  const script = resolveGeneratorScript();
  const python = resolvePythonBin();

  try {
    await access(script);
  } catch {
    return { ok: false, python, script, error: "The generator script is not readable." };
  }

  return new Promise<GeneratorHealth>((resolve) => {
    let settled = false;
    let guard: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: GeneratorHealth): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (guard) {
        clearTimeout(guard);
      }
      resolve(result);
    };

    try {
      // Exercise a REAL generation, not just `python --version`. A broken
      // script, a bad flag or a missing interpreter previously left the probe
      // green while every request returned 500.
      const child = spawn(
        python,
        [
          script,
          "--non-interactive",
          "--length",
          "16",
          "--special-count",
          "2",
          "--digit-count",
          "2",
          "--mixed-case-count",
          "4",
        ],
        { stdio: ["ignore", "pipe", "pipe"], env: childEnv(), windowsHide: true },
      );

      let output = "";
      guard = setTimeout(() => {
        child.kill("SIGKILL");
        settle({ ok: false, python, script, error: "The generator probe timed out." });
      }, 5_000);

      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        settle({ ok: false, python, script, error: error.message });
      });
      child.on("close", (code) => {
        if (code !== 0) {
          settle({
            ok: false,
            python,
            script,
            error: output.trim() || `The generator exited with code ${code}.`,
          });
          return;
        }
        const produced = output.trim().split(/\r?\n/).filter((line) => line.length > 0).pop() ?? "";
        if (produced.length !== 16 || !/^[\x21-\x7e]+$/.test(produced)) {
          settle({
            ok: false,
            python,
            script,
            error: "The generator probe did not return a usable value.",
          });
          return;
        }
        settle({ ok: true, python, script });
      });
    } catch (error) {
      settle({
        ok: false,
        python,
        script,
        error: error instanceof Error ? error.message : "Unable to run Python.",
      });
    }
  });
}

/**
 * Verify that Python and the shared script exist. Cached briefly so the
 * container health check does not spawn a process on every probe.
 */
export async function checkGeneratorHealth(): Promise<GeneratorHealth> {
  if (healthCache && healthCache.expiresAt > Date.now()) {
    return healthCache.value;
  }
  // Single-flight: a burst of health/readiness probes must not fan out into one
  // Python process each.
  if (healthInflight) {
    return healthInflight;
  }
  healthInflight = probeGenerator()
    .then((value) => {
      healthCache = { value, expiresAt: Date.now() + HEALTH_CACHE_MS };
      return value;
    })
    .finally(() => {
      healthInflight = null;
    });
  return healthInflight;
}

export function resetGeneratorHealthCache(): void {
  healthCache = null;
  healthInflight = null;
}
