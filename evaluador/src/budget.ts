// Per-run request budget (Task 9): the responsible-use counter that caps how
// many driver petitions one `runEval` may spend. It is pure in-memory state —
// no IO, no timers — so the orchestrator can decide before each driver call
// whether the run must pause with a declared gap (Fase 3bis).
//
// Accounting contract (the reason `take` charges partially):
//   - Before a call the orchestrator checks `exhausted` (`spent >= max`), which
//     is exactly the pinned gate `spent + 1 > max`: no call is made.
//   - After a call it charges the driver's real `calls` (1, or 2 when the single
//     structured-output retry fired). A retry can arrive when only one petition
//     is left; `take(2)` then charges that last petition, returns false, and
//     leaves the counter exhausted, so the accepted one-call overshoot can
//     never authorise another driver call. The real spawn count (max + 1 at
//     most) stays declared in `state.petitions`.
// `spent` never exceeds `max`; `take(n)` returns true iff the whole `n` fit.
// Zero runtime dependencies.
export class Budget {
  private readonly max: number;
  private used = 0;

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 0) {
      throw new RangeError(`budget must be a non-negative integer: ${max}`);
    }
    this.max = max;
  }

  /** Petitions charged so far (never above `max`). */
  get spent(): number {
    return this.used;
  }

  /** True when no further driver call may be made (`spent >= max`). */
  get exhausted(): boolean {
    return this.used >= this.max;
  }

  // Charges up to `n` petitions: all of them when they fit (true), otherwise
  // whatever capacity is left (false, never past `max`). `n` is the driver's
  // real `calls` in the post-call path, so a retry shortfall is visible here
  // while the actual spawn count remains in `state.petitions`.
  take(n: number): boolean {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`budget take must be a non-negative integer: ${n}`);
    }
    const room = this.max - this.used;
    if (n <= room) {
      this.used += n;
      return true;
    }
    this.used = this.max;
    return false;
  }
}
