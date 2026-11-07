// Driver seam: the minimal interface the orchestrator (Task 8) consumes and the
// phases never see. Implementations wrap a real agent backend (v1: an
// `opencode run` subprocess; v2 planned: ai-sdk) behind `Driver`.
// Zero runtime dependencies; see docs/superpowers/specs/2026-10-31-evaluador-design.md.

// One adversarial-review verdict over one claim, in the exact shape the report
// contract and the issue artifacts (Task 10) consume.
export type Verdict = {
  claimId: string;
  role: string;
  resultado: "ok" | "problema" | "sin-re-verificar";
  severidad: "aviso" | "bloqueante";
  hallazgo: string;
  evidencia: string[];
};

// Literal sets accepted by the manual Verdict validation. Exported from the
// driver seam (the orchestrator and the cache import them) so the schema has a
// single source; opencode.ts re-exports them for its existing consumers.
export const RESULTADOS = new Set(["ok", "problema", "sin-re-verificar"]);
export const SEVERIDADES = new Set(["aviso", "bloqueante"]);

// Runtime validation shared by the driver output, state loading and the verdict
// cache. Literal membership is enforced (not just `typeof`), and a non-ok
// verdict must carry a non-empty hallazgo: "problema"/"sin-re-verificar" owe an
// explanation, while a bare "ok" may legitimately have none.
export function isVerdict(value: unknown): value is Verdict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.claimId !== "string") return false;
  if (typeof record.role !== "string" || record.role === "") return false;
  if (typeof record.resultado !== "string" || !RESULTADOS.has(record.resultado)) {
    return false;
  }
  if (typeof record.severidad !== "string" || !SEVERIDADES.has(record.severidad)) {
    return false;
  }
  if (typeof record.hallazgo !== "string") return false;
  if (record.resultado !== "ok" && record.hallazgo.trim() === "") return false;
  const evidencia = record.evidencia;
  if (!Array.isArray(evidencia)) return false;
  if (evidencia.some((item) => typeof item !== "string")) return false;
  return true;
}

// One agent request. `allowFetch` is the resolved URL allowlist (Task 6); an
// empty list means the agent must not fetch anything at all. `blockedFetch`
// carries the URLs the claim cites but the allowlist rejects, so the driver can
// distinguish "there was nothing to fetch" from "the sources are outside the
// allowlist and a human must decide". `signal` is the optional cancellation seam
// (Task 8): when aborted by the orchestrator's per-call timeout, a real driver
// kills its spawned child. The Driver signature itself does not change.
// `model` is the per-run reviewer model (`--model provider/model`), passed
// through verbatim to the backend; absent means the backend's own default.
export interface AgentCall {
  role: string;
  rubric: string;
  material: string;
  allowFetch: string[];
  blockedFetch?: string[];
  signal?: AbortSignal;
  model?: string;
}

// What a driver returns. `calls` counts REAL subprocess spawns (1 normally,
// 2 when the single structured-output retry fires); the Budget accounting
// (Task 9) discounts exactly that number.
export interface AgentResult {
  verdicts: Verdict[];
  calls: number;
}

// The orchestrator gets exactly this; swapping backends touches nothing else.
export type Driver = (call: AgentCall) => Promise<AgentResult>;

// Injectable spawn shape so tests can fake the agent without touching the
// network or the real binary. `cmd` is the program to run, `args` its argv;
// the promise resolves with the child's full stdout and exit code (a rejected
// promise means the spawn itself failed, e.g. ENOENT). The optional `signal`
// lets the real implementation kill the child on abort; injected fakes may
// ignore it (fewer parameters stay assignable).
export type SpawnFn = (
  cmd: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<{ stdout: string; code: number }>;
