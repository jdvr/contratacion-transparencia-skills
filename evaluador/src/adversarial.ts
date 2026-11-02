// Phase orchestration (Task 8): `runEval` drives one report through the
// deterministic gate (Task 3) and the adversarial roles (Tasks 5–7), recording
// a resumable state in `<cwd>/.evaluador/state.json`. It is the only module
// that composes gate + rubric + cache + a driver; the driver is injected, so
// tests never spawn the real `opencode` binary.
//
// Evidence contract / exit semantics:
//   0 — zero `bloqueante` verdicts and every claim on an honest label;
//   1 — any blocking verdict (or a dishonest label, which the gate already
//       rejects before we get here);
//   2 — structural gate failed (machine-readable gaps; state is NOT written);
//   3 — usage-level: empty roles list (no state written) or an unreadable
//       report raised by the CLI.
//
// A driver call is bounded by DRIVER_TIMEOUT_MS (default 300 s). A timeout is
// treated exactly like a driver failure: it becomes an issue-able
// `sin-re-verificar` / `bloqueante` verdict and marks the claim `recheck`, so
// nothing throws out of runEval and a later run resumes from state.
//
// Fase 3bis — request budget (Task 9): before each driver call, an exhausted
// Budget (`spent + 1 > max`) stops the review instead of aborting it. The
// claim/role pair stays unbuilt, the claim is marked `recheck:
// "presupuesto-agotado"` and the run exits 1 with that declared gap; a later
// run with enough budget re-drives only the pairs that were never reviewed.
//
// Final-review hardening: state/cache/issues/outputs are written atomically,
// state+cache are checkpointed after each claim, and SIGINT/SIGTERM abort the
// in-flight call and persist a resumable pause (`recheck: "interrumpido"`)
// instead of losing the run.
//
// Issues (Task 10): at the end of every completed or paused run, `writeIssues`
// materializes one artifact per non-ok verdict and per unbuilt claim/role pair
// under `.evaluador/issues/`. Exit codes stay state-driven (0/1/2/3, unchanged):
// artifacts add no new code. The opt-in `gitBranches` flag opens
// `problema/<claimId>` only for claims with a blocking verdict; git failures
// are warnings and never change the exit code.
//
// Final outputs (Task 11): the same completed/paused path renders and writes
// `reporte-final.md`, `reporte-final.html`, `evidencia.json` and `resumen.json`
// into `outDir` (default: the report's own directory). The result carries the
// run-scoped accounting those artifacts need (`budget`, `spentThisRun`,
// `cacheHits`, `cacheMisses`) because `state.petitions` is cumulative across
// resumed runs.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Budget } from "./budget.js";
import { VerdictCache } from "./cache.js";
import type { Claim } from "./contract.js";
import { isVerdict } from "./driver/types.js";
import type { AgentCall, AgentResult, Driver, Verdict } from "./driver/types.js";
import { runGate } from "./gate.js";
import type { Gap } from "./gate.js";
import { createIssueBranches, writeIssues } from "./issues.js";
import { writeOutputs } from "./report.js";
import type { RunStats } from "./report.js";
import { DEFAULT_ROLES, RUBRIC_VERSION, resolveFetch, rubricFor } from "./rubric.js";
import type { RoleId } from "./rubric.js";
import { contentHash, writeFileAtomic } from "./state.js";

// One claim as reviewed in one run: the parsed claim, its content hash and the
// verdicts produced (one per role in v1, but the driver may return several per
// call). `recheck` is the declared gap that keeps exit 0 closed: it is set when
// any verdict is "sin-re-verificar" (driver failure / timeout / unreachable
// source), when the request budget stopped a pair before it could run
// ("presupuesto-agotado", Fase 3bis), or when SIGINT/SIGTERM paused the run
// ("interrumpido"; resumed like a budget pause, never like a failure). The
// per-pair gap is the absence of that role's verdict under the marker; Task 10
// turns it into an issue.
export interface RecordedClaim {
  claim: Claim;
  hash: string;
  verdicts: Verdict[];
  recheck?: "presupuesto-agotado" | "sin-re-verificar" | "interrumpido";
}

// The whole resumable state. `reporte` is the content hash of the parsed
// claims list (document order included), so any claim edit/reorder/add/remove
// changes it; `petitions` accumulates the driver `calls` spent under this state
// (honest accounting across resumed runs).
// Changes to the claim, the rubric version or the reviewer model label all
// change `hash`, so a verdict produced by model A is never adopted as model B's;
// older states (hashes computed before the model label joined the composition)
// are stale by design and their pairs are re-driven. No migration is attempted.
export interface EvaluatorState {
  version: 1;
  reporte: string;
  rubricVersion: string;
  claims: RecordedClaim[];
  petitions: number;
  updatedAt: string;
  // Roles requested by the run (Task 10): issue derivation needs to know which
  // claim × role pairs were in scope, so a subset run does not invent issues
  // for roles it never asked the driver to review. Optional for states written
  // before Task 10 / by hand; absent means the default role set.
  roles?: RoleId[];
}

// Claim identity for both the resumable state and the verdict cache. The
// reviewer model label is part of it (not just a recorded label): switching
// `--model` must yield fresh reviews, while the same model keeps the cache warm.
function claimHash(claim: Claim, model: string | undefined): string {
  return contentHash({
    claim,
    rubricVersion: RUBRIC_VERSION,
    modelLabel: modelLabel(model),
  });
}

// Per-call driver budget in milliseconds (Task 5 carry). Injectable via
// `runEval({ timeoutMs })` so tests do not wait 5 minutes.
export const DRIVER_TIMEOUT_MS = 300_000;

// Progress heartbeat while one driver call is in flight. A slow free model can
// legitimately take minutes per call; a silent CLI makes that look like a hang,
// so the default emits one line every 30 s (disable with heartbeatMs: 0).
export const HEARTBEAT_MS = 30_000;

// Human-readable duration for progress lines: sub-minute values keep one
// decimal, longer ones render as `4m04s`.
function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    return Number.isInteger(seconds)
      ? `${seconds}s`
      : `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

// Honest cache model name (pre-flight ruling): the orchestration cannot know
// which model `opencode run` selected, so it records what it actually did.
// With a per-run `--model`, modelLabel appends it so a cached verdict never
// claims more than it knows about the backend that produced it.
export const CACHE_MODEL = "opencode-run(v1)";

// Cache label for one run: the historical no-model string is preserved exactly;
// a requested model renders as `opencode-run(v1):<provider>/<model>`.
export function modelLabel(model: string | undefined): string {
  return model ? `${CACHE_MODEL}:${model}` : CACHE_MODEL;
}

// Canonical hallazgo for a timed-out call. Reports the actual configured
// budget: the default 300_000 ms renders the pinned "300 s" wording.
function timeoutHallazgo(timeoutMs: number): string {
  return `driver timeout (without response in ${timeoutMs / 1000} s)`;
}

const STATE_FILE = "state.json";
const CACHE_FILE = "cache.json";

// The four honest labels are the parsed claim's own label; the gate already
// rejects missing/invalid ones, so this check is a cheap defensive pin.
const HONEST_LABELS = new Set<string>([
  "VERIFICADO",
  "HIPÓTESIS",
  "PENDIENTE",
  "NO CONCLUYENTE",
]);

// ── state IO ──────────────────────────────────────────────────────────────

// Reads `<dir>/state.json`; `dir` is the `.evaluador` working directory.
// Never throws: a missing, unreadable, corrupt, wrong-version or wrong-shaped
// file is simply "no resumable state" (null). Individually invalid verdict
// entries are DROPPED (not fatal): the pair is then missing and the normal
// resume path re-drives it, so a corrupt literal can never be read as "ok" or
// keep a bogus blocker alive.
export function loadState(dir: string): EvaluatorState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!isEvaluatorState(raw)) return null;
  return sanitizeState(raw);
}

// Drops verdict entries that fail the shared runtime validator (literal
// membership included). Everything else in the state is kept verbatim.
function sanitizeState(state: EvaluatorState): EvaluatorState {
  return {
    ...state,
    claims: state.claims.map((recorded) => ({
      ...recorded,
      verdicts: recorded.verdicts.filter(isVerdict),
    })),
  };
}

// Writes `<dir>/state.json` (pretty JSON, trailing newline), creating `dir` if
// needed. The swap is atomic (writeFileAtomic): a kill mid-write cannot corrupt
// the resumable state.
export function saveState(dir: string, state: EvaluatorState): void {
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecordedClaim(value: unknown): value is RecordedClaim {
  if (!isRecord(value)) return false;
  if (!isRecord(value.claim) || typeof value.claim.id !== "string") return false;
  if (typeof value.hash !== "string") return false;
  // Verdict entries are validated one by one in sanitizeState (dropping the bad
  // ones); the claim shape only needs the container to be an array.
  if (!Array.isArray(value.verdicts)) return false;
  if (
    value.recheck !== undefined &&
    value.recheck !== "presupuesto-agotado" &&
    value.recheck !== "sin-re-verificar" &&
    value.recheck !== "interrumpido"
  ) {
    return false;
  }
  return true;
}

function isEvaluatorState(value: unknown): value is EvaluatorState {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.reporte === "string" &&
    typeof value.rubricVersion === "string" &&
    Array.isArray(value.claims) &&
    value.claims.every(isRecordedClaim) &&
    typeof value.petitions === "number" &&
    typeof value.updatedAt === "string" &&
    (value.roles === undefined || isStringArray(value.roles))
  );
}

// ── orchestration ─────────────────────────────────────────────────────────

export interface RunEvalOptions {
  reportPath: string;
  // Directory for the Task 11 artifacts (`reporte-final.md`, `.html`,
  // `evidencia.json`, `resumen.json`). Defaults to the report's own directory.
  // Relative values are resolved against `cwd`, like every other run path.
  outDir?: string;
  roles?: RoleId[];
  noCache?: boolean;
  // Petitions this run may spend on driver calls (default comes from
  // `.evaluador/config.json`, overridable with `--budget N`).
  budget: number;
  driver: Driver;
  cwd: string;
  // Per-call driver timeout (tests inject a small value).
  timeoutMs?: number;
  // Progress sink (stderr in the CLI). Default: silent, so library callers and
  // the test suite stay pristine unless they opt in.
  logger?: (line: string) => void;
  // Heartbeat cadence for in-flight calls; 0 disables it (tests).
  heartbeatMs?: number;
  // Reviewer model for every role in this run (`--model provider/model`).
  // Undefined means the backend's own default; the value is passed verbatim.
  model?: string;
  // Opt-in git branches for blocking issues (`--git-branches`, default off in
  // v1). Branch failures only warn; they never change the exit code.
  gitBranches?: boolean;
}

// Run-scoped accounting for the final summary (Task 11 carry #3): `state`
// preserves cumulative petitions, so this snapshot tells the renderers what
// THIS run spent and how much of it the cache served. `budget` is the run's
// declared cap; a gate failure or an empty-roles refusal still reports it with
// zero spending.
export interface RunEvalResult {
  code: 0 | 1 | 2 | 3;
  gaps?: Gap[];
  state: EvaluatorState;
  budget: number;
  spentThisRun: number;
  cacheHits: number;
  cacheMisses: number;
}

// Runs the phases for one report. Reads the report as text (an unreadable file
// rejects; the CLI maps that to exit 3), gates it first, then evaluates each
// claim × role. Cache hits (unless `noCache`) and same-hash state verdicts are
// adopted; only misses and `recheck` claims reach the driver.
export async function runEval(opts: RunEvalOptions): Promise<RunEvalResult> {
  const markdown = readFileSync(opts.reportPath, "utf8");
  const gate = runGate(markdown);
  const stateDir = join(opts.cwd, ".evaluador");
  const reportHash = contentHash(gate.claims);
  const roles = opts.roles ?? DEFAULT_ROLES;
  const timeoutMs = opts.timeoutMs ?? DRIVER_TIMEOUT_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const runStartedAt = Date.now();
  // A progress logger must never break a run: a throwing sink is swallowed.
  const emit = (line: string): void => {
    try {
      opts.logger?.(line);
    } catch {
      // ignore logger failures (progress is best-effort, never load-bearing)
    }
  };

  // Semantics 1: gate failure never touches state. The returned state is an
  // in-memory snapshot for the caller; it is deliberately not saved.
  if (!gate.ok) {
    return {
      code: 2,
      gaps: gate.gaps,
      state: freshState(
        gate.claims,
        reportHash,
        roles,
        new Date().toISOString(),
        opts.model,
      ),
      budget: opts.budget,
      spentThisRun: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
  }

  // Usage-level guard: an empty roles list requests no review at all. Refuse
  // it explicitly (exit 3, no state write) instead of returning a vacuous 0.
  if (roles.length === 0) {
    return {
      code: 3,
      state: freshState(
        gate.claims,
        reportHash,
        roles,
        new Date().toISOString(),
        opts.model,
      ),
      budget: opts.budget,
      spentThisRun: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
  }

  const totalPairs = gate.claims.length * roles.length;
  let pairIndex = 0;
  emit(
    `evaluador: ${gate.claims.length} claim(s) × ${roles.length} role(s) = ` +
      `${totalPairs} claim×role pair(s); roles: ${roles.join(", ")}; ` +
      `model: ${opts.model ?? "opencode default"}; timeout ${formatDuration(timeoutMs)}/call`,
  );

  const previous = loadState(stateDir);
  const budget = new Budget(opts.budget);
  // A state from another schema or rubric version is not resumable; cache keys
  // already include RUBRIC_VERSION, so those verdicts miss and get re-reviewed.
  const resumable =
    previous !== null &&
    previous.version === 1 &&
    previous.rubricVersion === RUBRIC_VERSION;
  const previousById = new Map<string, RecordedClaim>();
  if (resumable) {
    for (const recorded of previous.claims) {
      previousById.set(recorded.claim.id, recorded);
    }
  }

  const cache = new VerdictCache(join(stateDir, CACHE_FILE));
  const claims: RecordedClaim[] = [];
  // Roles accumulated in this state: a subset run (`--roles`) must not prune
  // the history of roles it did not request, and issue derivation needs every
  // role that has ever been in scope.
  const stateRoles: RoleId[] = resumable
    ? [...new Set<RoleId>([...(previous.roles ?? DEFAULT_ROLES), ...roles])]
    : [...roles];
  const startPetitions = resumable ? previous.petitions : 0;
  let petitions = startPetitions;
  // Per-run cache accounting (Task 11): one unit per claim × role pair, so
  // hits + misses is the review surface of THIS run. A pair whose verdicts are
  // adopted from state or the verdict cache is a hit; a pair that must reach
  // the driver is a miss (including one the budget then leaves unbuilt, and
  // every pair under --no-cache: the cache did not serve it).
  let cacheHits = 0;
  let cacheMisses = 0;
  let cacheDirty = false;

  // SIGINT/SIGTERM are a declared pause, not a crash: the handler aborts the
  // in-flight driver call, the loop stops, and state/cache are checkpointed so
  // the next run resumes from the completed pairs. Registered once per run and
  // removed in finally; runEval never calls process.exit.
  const runController = new AbortController();
  const onSignal = (): void => {
    runController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // In-memory snapshot of the state as it stands now. Checkpoints reuse it so
  // a completed claim is never lost to a hard kill.
  const snapshot = (): EvaluatorState => ({
    version: 1,
    reporte: reportHash,
    rubricVersion: RUBRIC_VERSION,
    claims: [...claims],
    petitions,
    updatedAt: new Date().toISOString(),
    roles: [...stateRoles],
  });

  // Checkpoint after each claim (the loop is bounded and the writes are cheap):
  // state + cache land atomically, so "reanudar por donde se quedó" survives a
  // Ctrl-C or a kill. Mid-role checkpoints would persist a half-reviewed pair.
  const checkpoint = (): void => {
    saveState(stateDir, snapshot());
    if (cacheDirty) cache.save();
  };

  let interrupted = false;

  try {
    for (const claim of gate.claims) {
      if (runController.signal.aborted) {
        interrupted = true;
        break;
      }
      const hash = claimHash(claim, opts.model);
      const recorded = previousById.get(claim.id);
      const reusable =
        resumable && recorded !== undefined && recorded.hash === hash
          ? recorded
          : undefined;
      // Resume semantics (Task 8 + final-review fix):
      //  - `sin-re-verificar` is a PER-ROLE retry: only roles whose last verdict
      //    was `sin-re-verificar` (or that never got one) reach the driver. Every
      //    other verdict is preserved, so a prior blocker can never vanish just
      //    because a retry was attempted (or the retry died on budget).
      //  - `presupuesto-agotado` / `interrumpido` are pauses: the verdicts already
      //    obtained are adopted and only the missing role pairs are re-driven.
      //  - A subset run (`--roles`) never prunes verdicts of roles it did not
      //    request: those are carried over untouched.
      const recheck = reusable?.recheck;
      const retryClaim = recheck === "sin-re-verificar";
      const pendingSinReverificar = recheck === "sin-re-verificar";
      const prior = reusable?.verdicts ?? [];
      const requested = new Set<RoleId>(roles);
      const verdicts: Verdict[] = prior.filter(
        (verdict) => !requested.has(verdict.role as RoleId),
      );
      const fetchRules = resolveFetch(claim);
      let budgetGap = false;
      let claimInterrupted = false;

      for (const role of roles) {
        pairIndex += 1;
        const tag = `[${pairIndex}/${totalPairs}] ${claim.id} · ${role}`;
        const priorForRole = prior.filter((verdict) => verdict.role === role);
        const retryRole =
          retryClaim &&
          (priorForRole.length === 0 ||
            priorForRole.some((verdict) => verdict.resultado === "sin-re-verificar"));
        // A completed prior review (or a cache hit) is adopted unless this role
        // is under a `sin-re-verificar` retry — its failed verdict must not mask
        // the retry — or `--no-cache` forces a full re-review.
        const canAdopt = !opts.noCache && !retryRole;

        if (canAdopt && priorForRole.length > 0) {
          cacheHits += 1;
          emit(`${tag}: reused from state`);
          verdicts.push(...priorForRole);
          continue;
        }
        if (canAdopt) {
          const cached = cache.get(hash, role);
          if (cached !== undefined) {
            cacheHits += 1;
            emit(`${tag}: cache hit`);
            verdicts.push(cached);
            continue;
          }
        }

        cacheMisses += 1;

        // Fase 3bis: the budget gate sits between the miss and the driver.
        // `exhausted` is exactly `spent + 1 > max`, so no call is made; the pair
        // stays unbuilt and the claim declares the gap.
        if (budget.exhausted) {
          budgetGap = true;
          emit(`${tag}: budget exhausted -> presupuesto-agotado`);
          continue;
        }

        const call: AgentCall = {
          role,
          rubric: rubricFor(role),
          material: materialFor(claim),
          allowFetch: fetchRules.allowed,
          blockedFetch: fetchRules.blocked,
          model: opts.model,
        };
        const startedAt = Date.now();
        emit(`${tag}: reviewing (timeout ${formatDuration(timeoutMs)})`);
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        if (heartbeatMs > 0) {
          heartbeat = setInterval(() => {
            emit(
              `${tag}: still running ${formatDuration(Date.now() - startedAt)} ` +
                `(timeout ${formatDuration(timeoutMs)})`,
            );
          }, heartbeatMs);
        }
        let result: AgentResult | "aborted";
        try {
          result = await invokeDriver(
            opts.driver,
            call,
            timeoutMs,
            runController.signal,
          );
        } finally {
          if (heartbeat !== undefined) clearInterval(heartbeat);
        }
        const elapsed = formatDuration(Date.now() - startedAt);
        if (result === "aborted") {
          // The spawn already happened, so charge it honestly; the pair and
          // every later one stay unbuilt under the declared `interrumpido` gap.
          emit(`${tag}: interrupted after ${elapsed}; state will resume`);
          budget.take(1);
          petitions += 1;
          claimInterrupted = true;
          break;
        }
        let assigned = result.verdicts.map((verdict) => ({
          ...verdict,
          claimId: claim.id, // Task 5 carry: the driver's verdict has claimId ""
          role, // the call's role always wins over the agent's echo
        }));
        if (assigned.length === 0) {
          // Defensive: a driver must return at least one verdict, but a declared
          // gap is better than silently losing the claim/role pair.
          assigned = [
            {
              ...failureVerdict(role, "driver returned no verdicts"),
              claimId: claim.id,
              role,
            },
          ];
        }
        for (const verdict of assigned) {
          // The cache holds one verdict per hash+role (the v1 driver returns one
          // per call); the state keeps every verdict of the call. With several
          // verdicts the last cached one wins, never silently dropping state.
          cache.put(hash, role, verdict, modelLabel(opts.model), new Date().toISOString());
        }
        cacheDirty = true;
        verdicts.push(...assigned);
        // Post-call accounting charges the real spawns (1, or 2 with retry). A
        // retry arriving with one petition left is accepted: the counter caps at
        // max and `petitions` keeps the one-call overshoot declared.
        budget.take(result.calls);
        petitions += result.calls;

        const timedOut = result.verdicts.some((verdict) =>
          verdict.hallazgo.startsWith("driver timeout"),
        );
        const outcome = assigned[0];
        const label = timedOut ? "TIMEOUT" : (outcome?.resultado ?? "no verdict");
        const severity = outcome?.severidad ?? "aviso";
        const retried = result.calls > 1 ? ` [${result.calls} spawns]` : "";
        emit(`${tag}: ${label} (${severity}) ${elapsed}${retried}`);
      }

      const next: RecordedClaim = { claim, hash, verdicts };
      // A pause (budget or signal) must never DROP a pending
      // `sin-re-verificar`: if that claim's retry did not complete, it keeps its
      // stronger marker (and its cache bypass) and only a completed retry may
      // reclassify it. A fresh pause is the weaker gap.
      if (claimInterrupted) {
        next.recheck = pendingSinReverificar ? "sin-re-verificar" : "interrumpido";
      } else if (
        verdicts.some((verdict) => verdict.resultado === "sin-re-verificar") ||
        (budgetGap && pendingSinReverificar)
      ) {
        next.recheck = "sin-re-verificar";
      } else if (budgetGap) {
        next.recheck = "presupuesto-agotado";
      }
      claims.push(next);
      checkpoint();
      if (claimInterrupted) {
        interrupted = true;
        break;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  // Interrupted run: persist the resumable state and stop with exit 1, without
  // rendering final artifacts (a report missing claims would look complete).
  // The `interrumpido` marker is mapped to an `sin-re-verificar` issue on the
  // next run, which re-drives only the pairs that never produced a verdict.
  if (interrupted) {
    const paused = snapshot();
    saveState(stateDir, paused);
    if (cacheDirty) cache.save();
    emit(
      `evaluador: interrupted after ${formatDuration(Date.now() - runStartedAt)}; ` +
        `state saved, re-run to resume ` +
        `(${petitions - startPetitions}/${opts.budget} call(s) spent this run)`,
    );
    return {
      code: 1,
      state: paused,
      budget: opts.budget,
      spentThisRun: petitions - startPetitions,
      cacheHits,
      cacheMisses,
    };
  }

  // Semantics 4: exit 0 only with zero blockers and honest labels on every
  // claim; a warning alone never blocks closure. A declared gap (driver
  // failure/timeout or a budget pause) also keeps the gate closed: exit 0 is
  // "sin huecos".
  const anyBlocking = claims.some((recorded) =>
    recorded.verdicts.some((verdict) => verdict.severidad === "bloqueante"),
  );
  const anyGap = claims.some((recorded) => recorded.recheck !== undefined);
  const allHonest = claims.every((recorded) =>
    HONEST_LABELS.has(recorded.claim.etiqueta),
  );

  // Defensive pre-exit invariant: every pair this run requested must end with a
  // verdict or a declared recheck. Unreachable in normal flow (a driver miss is
  // converted to a failure verdict), but cheap insurance against a future
  // refactor returning a vacuous 0.
  const missingPairs = unreviewedPairs(claims, roles);
  let code: 0 | 1 = anyBlocking || !allHonest || anyGap ? 1 : 0;
  if (code === 0 && missingPairs.length > 0) {
    console.error(
      `evaluador: warning: ${missingPairs.length} requested claim/role pair(s) have no verdict; refusing exit 0`,
    );
    code = 1;
  }

  const state: EvaluatorState = {
    version: 1,
    reporte: reportHash,
    rubricVersion: RUBRIC_VERSION,
    claims,
    petitions,
    updatedAt: new Date().toISOString(),
    roles: [...stateRoles],
  };
  saveState(stateDir, state);
  if (cacheDirty) cache.save();

  // Task 10: materialize the run's defects as artifacts before returning, then
  // (opt-in) open one branch per claim with a blocking verdict. Git failures
  // are warnings inside createIssueBranches and cannot change `code`.
  const allVerdicts = claims.flatMap((recorded) => recorded.verdicts);
  const blockers = allVerdicts.filter(
    (verdict) => verdict.severidad === "bloqueante",
  ).length;
  const issues = writeIssues(stateDir, allVerdicts, state);
  if (opts.gitBranches === true) {
    createIssueBranches(opts.cwd, allVerdicts);
  }

  // Task 11: the four final artifacts are written next to the report by
  // default, or under `-o <dir>`. A relative outDir is resolved against the
  // run's cwd (not the process cwd), so an embedded run never escapes its
  // working directory; writeOutputs does the mkdir -p. I/O failures propagate
  // and the CLI maps them to exit 3, like state/cache writes.
  const outDir = resolve(opts.cwd, opts.outDir ?? dirname(opts.reportPath));
  const spentThisRun = petitions - startPetitions;
  const runStats: RunStats = {
    budget: opts.budget,
    spentThisRun,
    cacheHits,
    cacheMisses,
  };
  writeOutputs(outDir, state, issues, runStats);
  emit(
    `evaluador: done: exit ${code}, ${blockers} blocker(s), ` +
      `${spentThisRun}/${opts.budget} call(s) this run, artifacts in ${outDir} ` +
      `(${formatDuration(Date.now() - runStartedAt)})`,
  );

  return {
    code,
    state,
    budget: opts.budget,
    spentThisRun,
    cacheHits,
    cacheMisses,
  };
}

// Claim/role pairs that the pre-exit invariant must reject: no verdict and no
// declared recheck. Exported so the defensive branch is unit-testable even
// though the normal flow cannot reach it.
export function unreviewedPairs(
  claims: RecordedClaim[],
  roles: RoleId[],
): Array<{ claim: string; role: RoleId }> {
  const missing: Array<{ claim: string; role: RoleId }> = [];
  for (const recorded of claims) {
    if (recorded.recheck !== undefined) continue;
    for (const role of roles) {
      if (!recorded.verdicts.some((verdict) => verdict.role === role)) {
        missing.push({ claim: recorded.claim.id, role });
      }
    }
  }
  return missing;
}

// Claim + evidence serialization handed to a reviewer. The claim object already
// carries every evidencia field of the report contract, so the material is its
// pretty JSON under a short label; the fetch allowlist travels separately in
// AgentCall.allowFetch.
function materialFor(claim: Claim): string {
  return `Claim under review (JSON):\n\n${JSON.stringify(claim, null, 2)}`;
}

// Runs one driver call under a hard timeout. At the deadline the call's
// AbortSignal fires, so the real driver kills its child: the call is abandoned
// and the timeout verdict is final (no orphan subprocess keeps the CLI alive).
// A rejection is likewise contained here as a declared failure, so an
// injected/buggy driver cannot abort the run. A SIGINT/SIGTERM (runSignal)
// returns "aborted" instead of a verdict: the pair was never reviewed and the
// caller records a declared pause, not a driver failure.
async function invokeDriver(
  driver: Driver,
  call: AgentCall,
  timeoutMs: number,
  runSignal: AbortSignal,
): Promise<AgentResult | "aborted"> {
  const controller = new AbortController();
  const abortableCall: AgentCall = { ...call, signal: controller.signal };
  let resolveAborted: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    resolveAborted = () => resolve("aborted");
  });
  const onRunAbort = (): void => {
    controller.abort();
    resolveAborted?.();
  };
  if (runSignal.aborted) {
    controller.abort();
    return "aborted";
  }
  runSignal.addEventListener("abort", onRunAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMs);
    });
    const outcome = await Promise.race([driver(abortableCall), timeout, aborted]);
    if (outcome === "aborted") {
      return "aborted";
    }
    if (outcome === "timeout") {
      return {
        verdicts: [failureVerdict(call.role, timeoutHallazgo(timeoutMs))],
        calls: 1,
      };
    }
    return outcome;
  } catch (error: unknown) {
    controller.abort();
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdicts: [failureVerdict(call.role, `driver failed: ${message}`)],
      calls: 1,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    runSignal.removeEventListener("abort", onRunAbort);
  }
}

// Canonical declared-gap verdict: `sin-re-verificar` + `bloqueante`, empty
// evidence, addressed to the claim's author. `claimId` stays "" for failures
// because the call has no claim id; runEval rewrites it when assigning.
function failureVerdict(role: string, hallazgo: string): Verdict {
  return {
    claimId: "",
    role,
    resultado: "sin-re-verificar",
    severidad: "bloqueante",
    hallazgo,
    evidencia: [],
  };
}

// Fresh in-memory state (no verdicts) used for the gate-failure snapshot.
// `hash` uses the same model-aware composition as the resumable path.
function freshState(
  claims: Claim[],
  reporte: string,
  roles: RoleId[],
  updatedAt: string,
  model: string | undefined,
): EvaluatorState {
  return {
    version: 1,
    reporte,
    rubricVersion: RUBRIC_VERSION,
    claims: claims.map((claim) => ({
      claim,
      hash: claimHash(claim, model),
      verdicts: [],
    })),
    petitions: 0,
    updatedAt,
    roles: [...roles],
  };
}
