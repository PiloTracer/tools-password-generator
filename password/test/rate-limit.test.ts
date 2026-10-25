import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  DEFAULT_REQUESTS_PER_MINUTE,
  checkRateLimit,
  coerceRequestsPerMinute,
  resetRateLimits,
} from "../lib/rate-limit.ts";

const NOW = 1_700_000_000_000;
const WINDOW_MS = 60_000;

describe("rate limiter", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows up to the limit, then refuses with a retry hint", () => {
    const first = checkRateLimit("client-a", 2, NOW);
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 1);

    const second = checkRateLimit("client-a", 2, NOW);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 0);

    const third = checkRateLimit("client-a", 2, NOW);
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfterSeconds >= 1);
  });

  it("isolates clients from each other", () => {
    checkRateLimit("client-a", 1, NOW);
    checkRateLimit("client-a", 1, NOW);
    const other = checkRateLimit("client-b", 1, NOW);
    assert.equal(other.allowed, true, "one client's usage must not throttle another");
  });

  it("treats a limit of 0 as disabled (documented switch)", () => {
    const result = checkRateLimit("unlimited", 0, NOW);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, Number.MAX_SAFE_INTEGER);
    assert.equal(result.retryAfterSeconds, 0);
  });

  it("restores the allowance in a fresh window", () => {
    checkRateLimit("windowed", 1, NOW);
    assert.equal(checkRateLimit("windowed", 1, NOW).allowed, false);
    const next = checkRateLimit("windowed", 1, NOW + WINDOW_MS + 1);
    assert.equal(next.allowed, true, "the next window starts clean");
  });

  it("fails closed at capacity instead of wiping every counter", () => {
    // One tracked client, so we can prove its counter survives a key flood.
    assert.equal(checkRateLimit("victim", 5, NOW).remaining, 4);

    let refusedAt = -1;
    for (let index = 0; index < 20_000; index += 1) {
      if (!checkRateLimit(`flood-${index}`, 5, NOW).allowed) {
        refusedAt = index;
        break;
      }
    }
    assert.ok(refusedAt > 0, "the table must eventually refuse new keys");

    // The victim's window was preserved: a second request leaves 3, not 4.
    const victim = checkRateLimit("victim", 5, NOW);
    assert.equal(victim.allowed, true);
    assert.equal(
      victim.remaining,
      3,
      "an existing counter must survive a flood (no global reset)",
    );
  });

  it("reclaims expired windows before refusing new keys", () => {
    for (let index = 0; index < 20_000; index += 1) {
      if (!checkRateLimit(`old-${index}`, 5, NOW).allowed) {
        break;
      }
    }
    // A later window lets those entries expire and be reclaimed.
    const later = checkRateLimit("newcomer", 5, NOW + WINDOW_MS + 1);
    assert.equal(later.allowed, true, "expired entries are reclaimed for newcomers");
  });
});

describe("requests-per-minute defaulting", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("uses a conservative default when the value is absent", () => {
    const result = checkRateLimit("absent", undefined as unknown as number, NOW);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, DEFAULT_REQUESTS_PER_MINUTE - 1);
  });

  it("an absent value is bounded, never 'unlimited'", () => {
    for (let index = 0; index < DEFAULT_REQUESTS_PER_MINUTE; index += 1) {
      assert.equal(checkRateLimit("bounded", undefined as unknown as number, NOW).allowed, true);
    }
    const over = checkRateLimit("bounded", undefined as unknown as number, NOW);
    assert.equal(over.allowed, false, "missing configuration must not remove throttling");
  });

  it("a negative value falls back to the default instead of disabling", () => {
    const result = checkRateLimit("negative", -5, NOW);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, DEFAULT_REQUESTS_PER_MINUTE - 1);
    assert.notEqual(result.remaining, Number.MAX_SAFE_INTEGER);
  });

  it("a fractional value below 1 falls back to the default", () => {
    const result = checkRateLimit("fractional", 0.5, NOW);
    assert.equal(result.remaining, DEFAULT_REQUESTS_PER_MINUTE - 1);
  });

  it("keeps the default in a range that is reasonable for a human-facing tool", () => {
    assert.ok(DEFAULT_REQUESTS_PER_MINUTE >= 10, "not so low that a person hits it");
    assert.ok(DEFAULT_REQUESTS_PER_MINUTE <= 60, "not so high that it stops being a guard");
  });

  describe("coerceRequestsPerMinute", () => {
    it("treats absent, empty and junk values as the fallback", () => {
      for (const value of [undefined, null, "", "   ", "abc", "12abc", true, {}, []]) {
        assert.equal(
          coerceRequestsPerMinute(value, 30),
          30,
          `value ${JSON.stringify(value)} should fall back`,
        );
      }
    });

    it("keeps an explicit zero, which is the documented disable switch", () => {
      assert.equal(coerceRequestsPerMinute(0, 30), 0);
      assert.equal(coerceRequestsPerMinute("0", 30), 0);
    });

    it("rejects negatives and sub-1 fractions", () => {
      assert.equal(coerceRequestsPerMinute(-1, 30), 30);
      assert.equal(coerceRequestsPerMinute(-0.5, 30), 30);
      assert.equal(coerceRequestsPerMinute(0.5, 30), 30);
    });

    it("accepts and floors valid numbers and numeric strings", () => {
      assert.equal(coerceRequestsPerMinute(12.9, 30), 12);
      assert.equal(coerceRequestsPerMinute("30", 30), 30);
      assert.equal(coerceRequestsPerMinute(1, 30), 1);
    });

    it("caps absurdly high values", () => {
      assert.equal(coerceRequestsPerMinute(999999, 30), 6000);
    });

    it("normalizes an unusable fallback itself", () => {
      assert.equal(coerceRequestsPerMinute(undefined, -1), DEFAULT_REQUESTS_PER_MINUTE);
    });
  });
});
