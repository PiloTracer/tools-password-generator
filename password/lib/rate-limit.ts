export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;

/**
 * Requests per minute applied when the policy does not provide a usable value.
 *
 * Deliberately conservative and below the edge limit (20 r/m + burst 10), so a
 * degraded policy layer tightens abuse limits rather than loosening them. It is
 * sized for a human using a password generator (a handful per minute), with
 * headroom for a shared NAT.
 */
export const DEFAULT_REQUESTS_PER_MINUTE = 30;

/**
 * Resolve a configured limit into the value the limiter actually uses.
 *
 * - absent / non-numeric / negative / fractional-below-1 → the default
 * - exactly `0` → `0`, the documented "disabled" switch
 *
 * The distinction matters: a missing or mistyped value must never silently
 * remove throttling, which is what treating "falsy" as "off" would do.
 */
export function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_REQUESTS_PER_MINUTE;
  }
  if (value === 0) {
    return 0;
  }
  if (value < 0) {
    return DEFAULT_REQUESTS_PER_MINUTE;
  }
  const whole = Math.floor(value);
  return whole < 1 ? DEFAULT_REQUESTS_PER_MINUTE : whole;
}

/**
 * Coerce an untrusted policy value into a limiter setting.
 *
 * Lives here — next to the limiter and with no imports — so it can be unit
 * tested without pulling in the Secrets Manager client.
 *
 * - absent / empty / non-numeric → `fallback`
 * - exactly `0` (number or "0") → `0`, the documented disable switch
 * - negative, or fractional below 1 → `fallback` (a typo must not disable)
 * - otherwise the whole number, capped at 6000
 *
 * `Number()` is used rather than `parseInt()` so `"12abc"` is rejected as junk
 * instead of silently becoming `12`.
 */
export function coerceRequestsPerMinute(value: unknown, fallback: number): number {
  const base = normalizeLimit(fallback);
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return base;
  }
  if (parsed === 0) {
    return 0;
  }
  const whole = Math.floor(parsed);
  if (whole < 1) {
    return base;
  }
  return Math.min(6000, whole);
}

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window, in-memory rate limiter.
 *
 * Only an explicit limit of `0` disables throttling. A missing, negative or
 * unusable value falls back to {@link DEFAULT_REQUESTS_PER_MINUTE} — throttling
 * is never removed by accident. This is a best-effort guard for a single-node
 * deployment, not a distributed limiter.
 *
 * Abuse note: the tracked key comes from a client-controllable address, so the
 * key space is unbounded by design. When the table is full and nothing has
 * expired, new keys are rejected (fail closed) instead of evicting live
 * counters. A previous implementation called `buckets.clear()` here, which let
 * any caller reset every other client's window with a burst of distinct keys.
 */
export function checkRateLimit(
  key: string,
  limitPerMinute: number,
  now = Date.now(),
): RateLimitResult {
  const limit = normalizeLimit(limitPerMinute);

  if (limit === 0) {
    return {
      allowed: true,
      remaining: Number.MAX_SAFE_INTEGER,
      retryAfterSeconds: 0,
      resetAt: now + WINDOW_MS,
    };
  }

  if (buckets.size >= MAX_BUCKETS) {
    // Reclaim only windows that have already expired. Live counters are never
    // discarded on behalf of a new caller.
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(bucketKey);
      }
    }
  }

  let bucket = buckets.get(key);

  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(WINDOW_MS / 1000)),
        resetAt: now + WINDOW_MS,
      };
    }
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  } else if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + WINDOW_MS;
  }

  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    resetAt: bucket.resetAt,
  };
}

export function resetRateLimits(): void {
  buckets.clear();
}
