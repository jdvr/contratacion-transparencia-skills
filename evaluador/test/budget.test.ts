// Tests for Task 9: the per-run request budget. The counter is pure state (no
// IO, no driver), so these cases pin the accounting contract the orchestrator
// relies on: `take()` charges what it can and reports whether the whole amount
// fit, so post-call accounting of a driver retry (calls: 2) still exhausts the
// counter and stops further driver calls.
import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget.js";

describe("Budget", () => {
  it("(a) Budget(2): two takes succeed, the third is refused and exhausted", () => {
    const budget = new Budget(2);

    expect(budget.spent).toBe(0);
    expect(budget.exhausted).toBe(false);
    expect(budget.take(1)).toBe(true);
    expect(budget.spent).toBe(1);
    expect(budget.take(1)).toBe(true);
    expect(budget.spent).toBe(2);
    expect(budget.exhausted).toBe(true);
    expect(budget.take(1)).toBe(false);
    expect(budget.spent).toBe(2); // refused take consumes nothing
    expect(budget.exhausted).toBe(true);
  });

  it("charges what it can and reports the shortfall (retry accounting)", () => {
    const budget = new Budget(3);

    expect(budget.take(2)).toBe(true);
    expect(budget.spent).toBe(2);
    // Only one petition is left; the two-call request is partially charged and
    // reported as not fully covered. It never pushes `spent` past `max`.
    expect(budget.take(2)).toBe(false);
    expect(budget.spent).toBe(3);
    expect(budget.exhausted).toBe(true);
  });

  it("Budget(0) is exhausted from the start and refuses every call", () => {
    const budget = new Budget(0);

    expect(budget.exhausted).toBe(true);
    expect(budget.take(1)).toBe(false);
    expect(budget.spent).toBe(0);
  });

  it("rejects invalid maxima and negative requests", () => {
    expect(() => new Budget(-1)).toThrow(RangeError);
    expect(() => new Budget(1.5)).toThrow(RangeError);
    expect(() => new Budget(Number.NaN)).toThrow(RangeError);
    expect(() => new Budget(2).take(-1)).toThrow(RangeError);
    expect(() => new Budget(2).take(1.5)).toThrow(RangeError);
  });
});
