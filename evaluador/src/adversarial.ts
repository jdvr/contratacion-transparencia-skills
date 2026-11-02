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
// Issues (Task 10): at the end of every completed or paused run, `writeIssues`
// materializes one artifact per non-ok verdict and per unbuilt claim/role pair
// under `.evaluador/issues/`. Exit codes stay state-driven (0/1/2/3, unchanged):
// artifacts add no new code. The opt-in `gitBranches` flag opens
// `problema/<claimId>` only for claims with a blocking verdict; git failures
// are warnings and never change the exit code.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Budget } from "./budget.js";
import { VerdictCache } from "./cache.js";
import type { Claim } from "./contract.js";
import type { AgentCall, AgentResult, Driver, Verdict } from "./driver/types.js";
import { runGate } from "./gate.js";
import type { Gap } from "./gate.js";
import { createIssueBranches, writeIssues } from "./issues.js";
import { DEFAULT_ROLES, RUBRIC_VERSION, resolveFetch, rubricFor } from "./rubric.js";
import type { RoleId } from "./rubric.js";
import { contentHash } from "./state.js";

// One claim as reviewed in one run: the parsed claim, its content hash and the
// verdicts produced (one per role in v1, but the driver may return several per
// call). `recheck` is the declared gap that keeps exit 0 closed: it is set when
// any verdict is "sin-re-verificar" (driver failure / timeout / unreachable
// source) and, taken by the request budget before a pair could run, as
// "presupuesto-agotado" (Fase 3bis). The per-pair gap is the absence of that
// role's verdict under the marker; Task 10 turns it into an issue.
export interface RecordedClaim {
  claim: Claim;
  hash: string;
  verdicts: Verdict[];
  recheck?: "presupuesto-agotado" | "sin-re-verificar";
}

// The whole resumable state. `reporte` is the content hash of the parsed
// claims list (document order included), so any claim edit/reorder/add/remove
// changes it; `petitions` accumulates the driver `calls` spent under this state
// (honest accounting across resumed runs).
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

// Per-call driver budget in milliseconds (Task 5 carry). Injectable via
// `runEval({ timeoutMs })` so tests do not wait 5 minutes.
export const DRIVER_TIMEOUT_MS = 300_000;

// Honest cache model name (pre-flight ruling): the orchestration cannot know
// which model `opencode run` selected, so it records what it actually did.
export const CACHE_MODEL = "opencode-run(v1)";

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
// file is simply "no resumable state" (null).
export function loadState(dir: string): EvaluatorState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
  return isEvaluatorState(raw) ? raw : null;
}

// Writes `<dir>/state.json` (pretty JSON, trailing newline), creating `dir` if
// needed. Orchestration is the only writer; tests use it to seed scenarios.
export function saveState(dir: string, state: EvaluatorState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerdict(value: unknown): value is Verdict {
  if (!isRecord(value)) return false;
  return (
    typeof value.claimId === "string" &&
    typeof value.role === "string" &&
    typeof value.resultado === "string" &&
    typeof value.severidad === "string" &&
    typeof value.hallazgo === "string" &&
    isStringArray(value.evidencia)
  );
}

function isRecordedClaim(value: unknown): value is RecordedClaim {
  if (!isRecord(value)) return false;
  if (!isRecord(value.claim) || typeof value.claim.id !== "string") return false;
  if (typeof value.hash !== "string") return false;
  if (!Array.isArray(value.verdicts) || !value.verdicts.every(isVerdict)) {
    return false;
  }
  if (
    value.recheck !== undefined &&
    value.recheck !== "presupuesto-agotado" &&
    value.recheck !== "sin-re-verificar"
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
  outDir?: string; // reserved for Task 11 outputs; not consumed here
  roles?: RoleId[];
  noCache?: boolean;
  // Petitions this run may spend on driver calls (default comes from
  // `.evaluador/config.json`, overridable with `--budget N`).
  budget: number;
  driver: Driver;
  cwd: string;
  // Per-call driver timeout (tests inject a small value).
  timeoutMs?: number;
  // Opt-in git branches for blocking issues (`--git-branches`, default off in
  // v1). Branch failures only warn; they never change the exit code.
  gitBranches?: boolean;
}

export interface RunEvalResult {
  code: 0 | 1 | 2 | 3;
  gaps?: Gap[];
  state: EvaluatorState;
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
      ),
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
      ),
    };
  }

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
  let petitions = resumable ? previous.petitions : 0;
  let cacheDirty = false;

  for (const claim of gate.claims) {
    const hash = contentHash({ claim, rubricVersion: RUBRIC_VERSION });
    const recorded = previousById.get(claim.id);
    const reusable =
      resumable && recorded !== undefined && recorded.hash === hash
        ? recorded
        : undefined;
    // A `sin-re-verificar` recheck forces every role of the claim through the
    // driver again, bypassing both state and cache (the previous verdicts must
    // not mask the retry). A `presupuesto-agotado` recheck is a pause, not a
    // failure: verdicts already obtained are valid and are adopted, and only
    // the role pairs the budget never reached go to the driver — resuming
    // "justo donde se quedó" without re-billing reviewed pairs.
    const recheck = reusable?.recheck;
    const bypass = recheck === "sin-re-verificar";
    const verdicts: Verdict[] = [];
    let budgetGap = false;

    for (const role of roles) {
      if (!opts.noCache && !bypass) {
        const prior =
          reusable?.verdicts.filter((verdict) => verdict.role === role) ?? [];
        if (prior.length > 0) {
          verdicts.push(...prior);
          continue;
        }
        const cached = cache.get(hash, role);
        if (cached !== undefined) {
          verdicts.push(cached);
          continue;
        }
      }

      // Fase 3bis: the budget gate sits between the miss and the driver.
      // `exhausted` is exactly `spent + 1 > max`, so no call is made; the pair
      // stays unbuilt and the claim declares the gap.
      if (budget.exhausted) {
        budgetGap = true;
        continue;
      }

      const call: AgentCall = {
        role,
        rubric: rubricFor(role),
        material: materialFor(claim),
        allowFetch: resolveFetch(claim).allowed,
      };
      const result = await invokeDriver(opts.driver, call, timeoutMs);
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
        cache.put(hash, role, verdict, CACHE_MODEL, new Date().toISOString());
      }
      cacheDirty = true;
      verdicts.push(...assigned);
      // Post-call accounting charges the real spawns (1, or 2 with retry). A
      // retry arriving with one petition left is accepted: the counter caps at
      // max and `petitions` keeps the one-call overshoot declared.
      budget.take(result.calls);
      petitions += result.calls;
    }

    const next: RecordedClaim = { claim, hash, verdicts };
    // A budget pause must never DROP a pending `sin-re-verificar`: if that
    // claim's retry did not complete, it keeps its stronger marker (and its
    // cache bypass) and only a completed retry may reclassify it. A fresh
    // budget-only pause is the weaker gap.
    const pendingSinReverificar = recheck === "sin-re-verificar";
    if (
      verdicts.some((verdict) => verdict.resultado === "sin-re-verificar") ||
      (budgetGap && pendingSinReverificar)
    ) {
      next.recheck = "sin-re-verificar";
    } else if (budgetGap) {
      next.recheck = "presupuesto-agotado";
    }
    claims.push(next);
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

  const state: EvaluatorState = {
    version: 1,
    reporte: reportHash,
    rubricVersion: RUBRIC_VERSION,
    claims,
    petitions,
    updatedAt: new Date().toISOString(),
    roles: [...roles],
  };
  saveState(stateDir, state);
  if (cacheDirty) cache.save();

  // Task 10: materialize the run's defects as artifacts before returning, then
  // (opt-in) open one branch per claim with a blocking verdict. Git failures
  // are warnings inside createIssueBranches and cannot change `code`.
  const allVerdicts = claims.flatMap((recorded) => recorded.verdicts);
  writeIssues(stateDir, allVerdicts, state);
  if (opts.gitBranches === true) {
    createIssueBranches(opts.cwd, allVerdicts);
  }

  return {
    code: anyBlocking || !allHonest || anyGap ? 1 : 0,
    state,
  };
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
// injected/buggy driver cannot abort the run.
async function invokeDriver(
  driver: Driver,
  call: AgentCall,
  timeoutMs: number,
): Promise<AgentResult> {
  const controller = new AbortController();
  const abortableCall: AgentCall = { ...call, signal: controller.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMs);
    });
    const outcome = await Promise.race([driver(abortableCall), timeout]);
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
function freshState(
  claims: Claim[],
  reporte: string,
  roles: RoleId[],
  updatedAt: string,
): EvaluatorState {
  return {
    version: 1,
    reporte,
    rubricVersion: RUBRIC_VERSION,
    claims: claims.map((claim) => ({
      claim,
      hash: contentHash({ claim, rubricVersion: RUBRIC_VERSION }),
      verdicts: [],
    })),
    petitions: 0,
    updatedAt,
    roles: [...roles],
  };
}
