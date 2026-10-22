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

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window, in-memory rate limiter.
 *
 * A limit of 0 (or a non-positive limit) disables throttling. This is a
 * best-effort guard for a single-node deployment, not a distributed limiter.
 */
export function checkRateLimit(
  key: string,
  limitPerMinute: number,
  now = Date.now(),
): RateLimitResult {
  if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) {
    return {
      allowed: true,
      remaining: Number.MAX_SAFE_INTEGER,
      retryAfterSeconds: 0,
      resetAt: now + WINDOW_MS,
    };
  }

  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(bucketKey);
      }
    }
    if (buckets.size > MAX_BUCKETS) {
      buckets.clear();
    }
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  return {
    allowed: bucket.count <= limitPerMinute,
    remaining: Math.max(0, limitPerMinute - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    resetAt: bucket.resetAt,
  };
}

export function resetRateLimits(): void {
  buckets.clear();
}
