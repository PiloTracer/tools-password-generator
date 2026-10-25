/**
 * Bounded concurrency for generator subprocesses.
 *
 * Kept in its own module so the bound is unit-testable without spawning Python:
 * the generator path itself is exercised end-to-end by `./bin/start.sh smoke`.
 *
 * Each run forks a full CPython interpreter (~18 MB RSS). Without a ceiling a
 * single unauthenticated caller can exhaust the container's memory with a few
 * hundred concurrent POSTs. Requests above the ceiling are refused (BUSY) rather
 * than queued, so latency cannot collapse under load.
 */

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 8;
  }
  return parsed;
}

/** Maximum concurrent generator runs. Override with GENERATOR_MAX_CONCURRENCY. */
export const MAX_CONCURRENT_RUNS = parseLimit(process.env.GENERATOR_MAX_CONCURRENCY);

let activeRuns = 0;

/** Reserve a slot. Returns false when the ceiling is already reached. */
export function tryAcquireSlot(): boolean {
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    return false;
  }
  activeRuns += 1;
  return true;
}

/** Release a slot. Safe to call when nothing is held. */
export function releaseSlot(): void {
  activeRuns = Math.max(0, activeRuns - 1);
}

/** Currently reserved slots (diagnostics and tests). */
export function activeSlots(): number {
  return activeRuns;
}

/** Reset to zero (tests only). */
export function resetSlots(): void {
  activeRuns = 0;
}
