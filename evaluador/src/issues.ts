// Issue artifacts (Task 10): every defect found by the adversarial review is
// materialized as `.evaluador/issues/<id>.json`, so a human (or the invoking
// model) can repair it without re-reading the whole run. An issue exists for
// every verdict that is NOT "ok" and for every claim/role pair the run never
// reached (declared gaps: driver failure/timeout or an exhausted request
// budget). Verdict-derived issues come first, in state claim order, then the
// gap-derived ones per claim × role in role order.
//
// Id policy (deterministic, documented): ids are positional (`i-001`, `i-002`,
// …) over that stable enumeration. Re-running with unchanged state and
// verdicts therefore reuses exactly the same ids and bytes; ids may shift only
// when the reviewed content changes (v1 keeps no persistent id registry). Files
// whose issue no longer exists are pruned, so a fixed problem does not leave a
// stale artifact behind.
//
// Severity comes from the verdict for verdict-derived issues; a declared gap is
// "bloqueante" because closure cannot be trusted until the pair is reviewed.
// `rubricItem` names the role's one rubric check (the rule that failed or could
// not run); `propuesta` is a one-line next step derived from the hallazgo.
//
// Git (opt-in, `--git-branches`, default off in v1): after the issues are
// written, runEval may create `problema/<claimId>` with `git switch -c`, ONLY
// for claims with a non-ok bloqueante verdict. Git failures print a warning and
// never alter the exit code. Zero runtime dependencies.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EvaluatorState } from "./adversarial.js";
import type { Verdict } from "./driver/types.js";
import { DEFAULT_ROLES } from "./rubric.js";

export interface Issue {
  id: string; // p. ej. "i-001"
  claimId?: string;
  role: string;
  severity: "aviso" | "bloqueante";
  rubricItem: string; // qué regla de la rubric falla
  hallazgo: string;
  propuesta: string;
  estado: "abierta" | "cerrada" | "sin-re-verificar";
}

// One-line human labels for the single rubric check each role owns. Keeping
// them here (presentation) avoids coupling the rubric prompts to issue output;
// an unknown/custom role falls back to its hallazgo.
const RUBRIC_ITEM_BY_ROLE: Record<string, string> = {
  contadores:
    "filas traídas vs total declarado, criterio del total y una suma con un criterio",
  "segunda-fuente": "contraste por una vía lógicamente distinta, con la ruta declarada",
  falsificador:
    "intento de falsificación: GROUP BY alternativo, filtro inverso y rango mayor",
  metodico:
    "cobertura declarada, presupuesto de peticiones, trampas de contenedor y etiquetas honestas",
};

const ISSUES_DIR = "issues";
const ISSUE_FILE = /^i-\d+\.json$/;

// Writes one `<id>.json` per issue under `<dir>/issues/` (`dir` is the
// `.evaluador` working directory, like loadState/saveState) and returns them in
// id order. `verdicts` is the flat list of verdicts of the run (adopted or
// fresh); `state` supplies claim order, the declared recheck markers and the
// roles that were requested. Never throws for ordinary data: only I/O errors
// propagate (the CLI maps them to exit 3).
export function writeIssues(
  dir: string,
  verdicts: Verdict[],
  state: EvaluatorState,
): Issue[] {
  const roles = state.roles ?? DEFAULT_ROLES;
  const issues: Issue[] = [];

  // Verdict-derived: one issue per non-ok verdict, ordered by claim position in
  // state (not by the flat array), then by the verdict order inside the claim.
  for (const verdict of orderByState(verdicts, state)) {
    if (verdict.resultado === "ok") continue;
    issues.push(verdictIssue(verdict, state));
  }

  // Gap-derived: a claim carrying a recheck marker with no verdict for a role
  // is an unbuilt pair. This is the Task 9 carry: the gap is derived from the
  // marker + the ABSENT role, never from the presence of "sin-re-verificar"
  // verdicts (a paused claim may legitimately carry zero verdicts).
  for (const recorded of state.claims) {
    if (recorded.recheck === undefined) continue;
    for (const role of roles) {
      if (recorded.verdicts.some((verdict) => verdict.role === role)) continue;
      issues.push(gapIssue(recorded.claim.id, role, recorded.recheck));
    }
  }

  for (const [index, issue] of issues.entries()) {
    issue.id = `i-${String(index + 1).padStart(3, "0")}`;
  }

  writeArtifacts(dir, issues);
  return issues;
}

// Sorts verdicts by the claim's position in state, preserving the flat order
// within a claim (and the relative order of unknown claims, appended last).
function orderByState(verdicts: Verdict[], state: EvaluatorState): Verdict[] {
  const position = new Map<string, number>();
  state.claims.forEach((recorded, index) => {
    position.set(recorded.claim.id, index);
  });
  return verdicts
    .map((verdict, index) => ({ verdict, index }))
    .sort((a, b) => {
      const pa = position.get(a.verdict.claimId) ?? Number.MAX_SAFE_INTEGER;
      const pb = position.get(b.verdict.claimId) ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || a.index - b.index;
    })
    .map(({ verdict }) => verdict);
}

function verdictIssue(verdict: Verdict, state: EvaluatorState): Issue {
  const claim = state.claims.find(
    (recorded) => recorded.claim.id === verdict.claimId,
  );
  const hallazgo = oneLine(verdict.hallazgo);
  return {
    id: "", // assigned positionally in writeIssues
    // A driver failure has no claim in state only if the verdict came from an
    // unknown claim; keep its echoed id rather than dropping the issue.
    claimId: claim?.claim.id ?? verdict.claimId,
    role: verdict.role,
    severity: verdict.severidad,
    rubricItem: rubricItemFor(verdict.role, hallazgo),
    hallazgo,
    propuesta: propuestaFor(hallazgo),
    estado: verdict.resultado === "problema" ? "abierta" : "sin-re-verificar",
  };
}

function gapIssue(
  claimId: string,
  role: string,
  recheck: NonNullable<EvaluatorState["claims"][number]["recheck"]>,
): Issue {
  const hallazgo =
    recheck === "presupuesto-agotado"
      ? "no re-verificado: presupuesto agotado"
      : "no re-verificado: reintento pendiente";
  return {
    id: "",
    claimId,
    role,
    // A pair that was never reviewed blocks closure: the claimed figure has no
    // adversarial verdict yet.
    severity: "bloqueante",
    rubricItem: rubricItemFor(role, hallazgo),
    hallazgo,
    propuesta: propuestaFor(hallazgo),
    estado: "sin-re-verificar",
  };
}

function rubricItemFor(role: string, hallazgo: string): string {
  return RUBRIC_ITEM_BY_ROLE[role] ?? (hallazgo === "" ? `rol ${role}` : hallazgo);
}

// The proposal is a one-line next step derived from the hallazgo; it never
// invents evidence beyond what the reviewer already said.
function propuestaFor(hallazgo: string): string {
  const line = hallazgo === "" ? "revisar el hallazgo señalado" : hallazgo;
  return `Corregir y re-verificar: ${line}`;
}

// Collapses any whitespace run (newlines included) into a single space so each
// issue field stays one line in the artifact and in human-facing output.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Writes the artifacts and prunes generated issue files that no longer
// correspond to an issue (e.g. after the defect was fixed).
function writeArtifacts(dir: string, issues: Issue[]): void {
  const issuesDir = join(dir, ISSUES_DIR);
  const keep = new Set(issues.map((issue) => `${issue.id}.json`));

  if (existsSync(issuesDir)) {
    for (const name of readdirSync(issuesDir)) {
      if (ISSUE_FILE.test(name) && !keep.has(name)) {
        rmSync(join(issuesDir, name), { force: true });
      }
    }
  }

  if (issues.length === 0) return;
  mkdirSync(issuesDir, { recursive: true });
  for (const issue of issues) {
    writeFileSync(
      join(issuesDir, `${issue.id}.json`),
      JSON.stringify(issue, null, 2) + "\n",
    );
  }
}

// Creates `problema/<claimId>` (git switch -c) for every claim with a non-ok
// bloqueante verdict — exactly the issues derived from a blocking verdict, so
// declared gaps (which carry no verdict) never create a branch. Failures are
// warnings only: git must never change the review's exit code. Returns the
// branch names git actually created (useful for logs/tests).
export function createIssueBranches(cwd: string, verdicts: Verdict[]): string[] {
  const claimIds: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.resultado === "ok") continue;
    if (verdict.severidad !== "bloqueante") continue;
    if (!claimIds.includes(verdict.claimId)) claimIds.push(verdict.claimId);
  }

  const created: string[] = [];
  for (const claimId of claimIds) {
    const branch = branchNameFor(claimId);
    const result = spawnSync("git", ["switch", "-c", branch], {
      cwd,
      encoding: "utf8",
    });
    if (result.status === 0) {
      created.push(branch);
      continue;
    }
    const reason =
      result.error?.message ??
      (result.stderr.trim() === ""
        ? `exit ${result.status ?? "?"}`
        : result.stderr.trim());
    console.error(
      `evaluador: warning: no se pudo crear la rama ${branch}: ${oneLine(reason)}`,
    );
  }
  return created;
}

// Git ref-safe branch name; invalid runs collapse to one dash. An id with no
// safe characters yields a deterministic fallback (never an empty ref).
function branchNameFor(claimId: string): string {
  const safe = claimId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `problema/${safe === "" ? "claim" : safe}`;
}
