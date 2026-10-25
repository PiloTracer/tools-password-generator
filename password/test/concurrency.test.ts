import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  MAX_CONCURRENT_RUNS,
  activeSlots,
  releaseSlot,
  resetSlots,
  tryAcquireSlot,
} from "../lib/concurrency.ts";

describe("generator concurrency ceiling", () => {
  beforeEach(() => {
    resetSlots();
  });

  it("grants exactly MAX_CONCURRENT_RUNS slots and then refuses", () => {
    for (let index = 0; index < MAX_CONCURRENT_RUNS; index += 1) {
      assert.equal(tryAcquireSlot(), true, `slot ${index + 1} should be granted`);
    }
    assert.equal(tryAcquireSlot(), false, "one past the ceiling must be refused");
    assert.equal(activeSlots(), MAX_CONCURRENT_RUNS);
  });

  it("refuses instead of queueing, so latency cannot collapse", () => {
    for (let index = 0; index < MAX_CONCURRENT_RUNS; index += 1) {
      tryAcquireSlot();
    }
    const started = Date.now();
    assert.equal(tryAcquireSlot(), false);
    assert.ok(Date.now() - started < 50, "refusal is immediate, not a wait");
  });

  it("frees a slot as soon as a run completes", () => {
    for (let index = 0; index < MAX_CONCURRENT_RUNS; index += 1) {
      tryAcquireSlot();
    }
    assert.equal(tryAcquireSlot(), false);
    releaseSlot();
    assert.equal(tryAcquireSlot(), true, "a released slot is immediately reusable");
  });

  it("never goes negative when released without a matching acquire", () => {
    releaseSlot();
    releaseSlot();
    assert.equal(activeSlots(), 0);
    assert.equal(tryAcquireSlot(), true);
  });

  it("has a usable ceiling under any environment", () => {
    assert.ok(Number.isInteger(MAX_CONCURRENT_RUNS));
    assert.ok(MAX_CONCURRENT_RUNS >= 1);
  });
});
