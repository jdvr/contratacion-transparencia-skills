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

// One agent request. `allowFetch` is the resolved URL allowlist (Task 6); an
// empty list means the agent must not fetch anything at all.
export interface AgentCall {
  role: string;
  rubric: string;
  material: string;
  allowFetch: string[];
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
// promise means the spawn itself failed, e.g. ENOENT).
export type SpawnFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; code: number }>;
