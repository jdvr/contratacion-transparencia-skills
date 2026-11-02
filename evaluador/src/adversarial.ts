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
  // Concurrent claim×role workers. The library default is 1 (sequential); the
  // CLI passes 4 unless --jobs overrides it.
  jobs?: number;
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

// Per-claim accumulator for the parallel scheduler. `verdictsByRole` is indexed
// by the `roles` array so responses can arrive in any order while the state and
// issue order stay driven by the role order.
interface ClaimAccumulator {
  claim: Claim;
  hash: string;
  verdictsByRole: Verdict[][];
  prior: Verdict[];
  retryClaim: boolean;
  pendingSinReverificar: boolean;
  budgetGap: boolean;
  interrupted: boolean;
  started: boolean;
}

// One queued driver call. `pairIndex` is assigned in claim→role order and is
// the stable `[i/total]` progress label.
interface PairTask {
  acc: ClaimAccumulator;
  role: RoleId;
  roleIndex: number;
  pairIndex: number;
}

function pairTag(task: PairTask, totalPairs: number): string {
  return `[${task.pairIndex}/${totalPairs}] ${task.acc.claim.id} · ${task.role}`;
}

// Deterministic state projection: gate order for claims, role order for the
// requested verdicts, carried non-requested roles first (subset semantics).
function materializeClaims(
  accs: ClaimAccumulator[],
  roles: RoleId[],
): RecordedClaim[] {
  const requested = new Set<RoleId>(roles);
  const out: RecordedClaim[] = [];
  for (const acc of accs) {
    // Claims the pool never reached are omitted, like the old sequential loop
    // omitted claims it had not processed yet. Adopted roles and popped pairs
    // set `started`, so all-cache-hit claims and declared gaps stay in state.
    if (!acc.started) continue;
    const carried = acc.prior.filter(
      (verdict) => !requested.has(verdict.role as RoleId),
    );
    const verdicts = [...carried, ...acc.verdictsByRole.flat()];
    if (verdicts.length === 0 && !acc.budgetGap && !acc.interrupted) continue;
    let recheck: RecordedClaim["recheck"];
    if (acc.interrupted) {
      // A pause must never drop a pending sin-re-verificar (Task 9 ruling).
      recheck = acc.pendingSinReverificar ? "sin-re-verificar" : "interrumpido";
    } else if (
      verdicts.some((verdict) => verdict.resultado === "sin-re-verificar") ||
      (acc.budgetGap && acc.pendingSinReverificar)
    ) {
      recheck = "sin-re-verificar";
    } else if (acc.budgetGap) {
      recheck = "presupuesto-agotado";
    }
    const recorded: RecordedClaim = {
      claim: acc.claim,
      hash: acc.hash,
      verdicts,
    };
    if (recheck !== undefined) recorded.recheck = recheck;
    out.push(recorded);
  }
  return out;
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
  const jobs = opts.jobs ?? 1;
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

  // Embedded callers can pass an invalid pool size; the CLI parser already
  // rejects it, so this is the same fail-closed usage path as empty roles.
  if (!Number.isInteger(jobs) || jobs < 1) {
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
  emit(
    `evaluador: ${gate.claims.length} claim(s) × ${roles.length} role(s) = ` +
      `${totalPairs} claim×role pair(s); roles: ${roles.join(", ")}; ` +
      `model: ${opts.model ?? "opencode default"}; jobs: ${jobs}; ` +
      `timeout ${formatDuration(timeoutMs)}/call`,
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

  // ── plan: accumulators per claim, tasks for the pairs that need the driver ──
  // Adoption (state/cache) is synchronous and happens here, in claim→role
  // order; the pool only sees misses. The budget is checked later, immediately
  // before each launch.
  const accs: ClaimAccumulator[] = gate.claims.map((claim) => {
    const hash = claimHash(claim, opts.model);
    const recorded = previousById.get(claim.id);
    const reusable =
      resumable && recorded !== undefined && recorded.hash === hash
        ? recorded
        : undefined;
    const recheck = reusable?.recheck;
    return {
      claim,
      hash,
      verdictsByRole: roles.map(() => []),
      prior: reusable?.verdicts ?? [],
      retryClaim: recheck === "sin-re-verificar",
      pendingSinReverificar: recheck === "sin-re-verificar",
      budgetGap: false,
      interrupted: false,
      // A claim with prior verdicts is already part of the state even if this
      // run never pops one of its requested-role tasks (carried subset case).
      started: (reusable?.verdicts.length ?? 0) > 0,
    };
  });

  const tasks: PairTask[] = [];
  let planned = 0;
  for (const acc of accs) {
    for (let roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
      const role = roles[roleIndex] as RoleId;
      planned += 1;
      const plannedIndex = planned;
      const tag = `[${plannedIndex}/${totalPairs}] ${acc.claim.id} · ${role}`;
      const priorForRole = acc.prior.filter((verdict) => verdict.role === role);
      const retryRole =
        acc.retryClaim &&
        (priorForRole.length === 0 ||
          priorForRole.some((verdict) => verdict.resultado === "sin-re-verificar"));
      // A completed prior review (or a cache hit) is adopted unless this role
      // is under a sin-re-verificar retry or --no-cache forces a re-review.
      const canAdopt = !opts.noCache && !retryRole;

      if (canAdopt && priorForRole.length > 0) {
        cacheHits += 1;
        acc.verdictsByRole[roleIndex] = priorForRole;
        acc.started = true;
        emit(`${tag}: reused from state`);
        continue;
      }
      if (canAdopt) {
        const cached = cache.get(acc.hash, role);
        if (cached !== undefined) {
          cacheHits += 1;
          acc.verdictsByRole[roleIndex] = [cached];
          acc.started = true;
          emit(`${tag}: cache hit`);
          continue;
        }
      }

      cacheMisses += 1;
      tasks.push({ acc, role, roleIndex, pairIndex: plannedIndex });
    }
  }

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
  // a completed pair is never lost to a hard kill.
  const snapshot = (): EvaluatorState => ({
    version: 1,
    reporte: reportHash,
    rubricVersion: RUBRIC_VERSION,
    claims: materializeClaims(accs, roles),
    petitions,
    updatedAt: new Date().toISOString(),
    roles: [...stateRoles],
  });

  // Checkpoint after each pair (the writes are small and atomic), so a parallel
  // run can resume from the pairs that already landed, not from the last claim.
  const checkpoint = (): void => {
    saveState(stateDir, snapshot());
    if (cacheDirty) cache.save();
  };

  const runPair = async (task: PairTask): Promise<void> => {
    const { acc, role, roleIndex } = task;
    const tag = pairTag(task, totalPairs);
    const fetchRules = resolveFetch(acc.claim);
    const call: AgentCall = {
      role,
      rubric: rubricFor(role),
      material: materialFor(acc.claim),
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
      // The spawn already happened, so charge it honestly; the pair and every
      // later one stay unbuilt under the declared `interrumpido` gap.
      emit(`${tag}: interrupted after ${elapsed}; state will resume`);
      budget.take(1);
      petitions += 1;
      acc.interrupted = true;
      return;
    }
    let assigned = result.verdicts.map((verdict) => ({
      ...verdict,
      claimId: acc.claim.id, // Task 5 carry: the driver's verdict has claimId ""
      role, // the call's role always wins over the agent's echo
    }));
    if (assigned.length === 0) {
      // Defensive: a driver must return at least one verdict, but a declared
      // gap is better than silently losing the claim/role pair.
      assigned = [
        {
          ...failureVerdict(role, "driver returned no verdicts"),
          claimId: acc.claim.id,
          role,
        },
      ];
    }
    for (const verdict of assigned) {
      // The cache holds one verdict per hash+role (the v1 driver returns one
      // per call); the state keeps every verdict of the call.
      cache.put(
        acc.hash,
        role,
        verdict,
        modelLabel(opts.model),
        new Date().toISOString(),
      );
    }
    cacheDirty = true;
    (acc.verdictsByRole[roleIndex] ??= []).push(...assigned);
    // Post-call accounting charges the real spawns (1, or 2 with retry). A
    // retry arriving with one petition left is accepted: the counter caps at
    // max and `petitions` keeps the overshoot declared.
    budget.take(result.calls);
    petitions += result.calls;
    checkpoint();

    const timedOut = result.verdicts.some((verdict) =>
      verdict.hallazgo.startsWith("driver timeout"),
    );
    const outcome = assigned[0];
    const label = timedOut ? "TIMEOUT" : (outcome?.resultado ?? "no verdict");
    const severity = outcome?.severidad ?? "aviso";
    const retried = result.calls > 1 ? ` [${result.calls} spawns]` : "";
    emit(`${tag}: ${label} (${severity}) ${elapsed}${retried}`);
  };

  // Worker pool: pop pairs in plan order, check the soft budget immediately
  // before each launch, and let in-flight calls finish. `firstError` (an I/O
  // failure in cache/state) aborts the run; the other workers then stop
  // launching and their in-flight calls are killed by the same signal.
  let cursor = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (
      firstError === undefined &&
      !runController.signal.aborted &&
      cursor < tasks.length
    ) {
      const task = tasks[cursor] as PairTask;
      cursor += 1;
      task.acc.started = true;
      if (budget.exhausted) {
        task.acc.budgetGap = true;
        emit(
          `${pairTag(task, totalPairs)}: budget exhausted -> presupuesto-agotado`,
        );
        continue;
      }
      try {
        await runPair(task);
      } catch (error: unknown) {
        firstError = error;
        runController.abort();
      }
    }
  };

  try {
    const workerCount = Math.min(jobs, tasks.length);
    await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker()),
    );
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  if (firstError !== undefined) throw firstError;

  // Pairs the pool never launched after a signal: mark the started claims as
  // interrupted. Claims never reached stay out of state, exactly like the old
  // sequential loop. (Without abort or firstError, the workers sweep every
  // remaining task through the budget-gap branch above.)
  if (runController.signal.aborted) {
    for (let i = cursor; i < tasks.length; i += 1) {
      const acc = (tasks[i] as PairTask).acc;
      if (acc.started) acc.interrupted = true;
    }
  }
  const interrupted = accs.some((acc) => acc.interrupted);

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

  // Final deterministic projection in claim→role order.
  const finalClaims = materializeClaims(accs, roles);

  // Semantics 4: exit 0 only with zero blockers and honest labels on every
  // claim; a warning alone never blocks closure. A declared gap (driver
  // failure/timeout or a budget pause) also keeps the gate closed: exit 0 is
  // "sin huecos".
  const anyBlocking = finalClaims.some((recorded) =>
    recorded.verdicts.some((verdict) => verdict.severidad === "bloqueante"),
  );
  const anyGap = finalClaims.some((recorded) => recorded.recheck !== undefined);
  const allHonest = finalClaims.every((recorded) =>
    HONEST_LABELS.has(recorded.claim.etiqueta),
  );

  // Defensive pre-exit invariant: every pair this run requested must end with a
  // verdict or a declared recheck. Unreachable in normal flow (a driver miss is
  // converted to a failure verdict), but cheap insurance against a future
  // refactor returning a vacuous 0.
  const missingPairs = unreviewedPairs(finalClaims, roles);
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
    claims: finalClaims,
    petitions,
    updatedAt: new Date().toISOString(),
    roles: [...stateRoles],
  };
  saveState(stateDir, state);
  if (cacheDirty) cache.save();

  // Task 10: materialize the run's defects as artifacts before returning, then
  // (opt-in) open one branch per claim with a blocking verdict. Git failures
  // are warnings inside createIssueBranches and cannot change `code`.
  const allVerdicts = finalClaims.flatMap((recorded) => recorded.verdicts);
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
  const overshoot =
    spentThisRun > opts.budget
      ? ` (+${spentThisRun - opts.budget} call(s) over budget)`
      : "";
  emit(
    `evaluador: done: exit ${code}, ${blockers} blocker(s), ` +
      `${spentThisRun}/${opts.budget} call(s) this run${overshoot}, jobs ${jobs}, ` +
      `artifacts in ${outDir} (${formatDuration(Date.now() - runStartedAt)})`,
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
