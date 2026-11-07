// v1 driver: runs one `opencode run <prompt>` subprocess per call and extracts
// a structured Verdict from its stdout. The driver NEVER throws: every failure
// mode (spawn error, non-zero exit, unparseable/invalid output after the single
// retry) degrades to a Verdict with resultado "sin-re-verificar" and severity
// "bloqueante" (see docs/superpowers/specs/2026-10-31-evaluador-design.md).
import { spawn } from "node:child_process";
import { RESULTADOS, SEVERIDADES } from "./types.js";
import type {
  AgentCall,
  AgentResult,
  Driver,
  SpawnFn,
  Verdict,
} from "./types.js";

// Back-compat re-export: the sets now live with the Verdict schema (types.ts)
// so state/cache can share them without importing the subprocess driver.
export { RESULTADOS, SEVERIDADES };

// Injected when the claim cites nothing fetchable (allowlist lives in Task 6).
const NO_FETCH_PHRASE = "No hagas fetch: marca resultado sin-re-verificar";
// Injected when the claim DOES cite sources, but all of them are outside the
// allowlist: the reviewer is told why it cannot fetch and what to declare,
// instead of being told (falsely) that there is nothing to fetch.
const BLOCKED_FETCH_SUFFIX =
  "Si necesitas consultar una fuente y no puedes fetch, marca resultado " +
  "sin-re-verificar y cita el dominio en hallazgo";
// Appended on the single retry for unparseable/invalid output.
const RETRY_SUFFIX = "SOLO el bloque fenced ```json, sin texto fuera de él";
const VERDICT_SCHEMA =
  '{"claimId": string, "role": string, "resultado": "ok" | "problema" | ' +
  '"sin-re-verificar", "severidad": "aviso" | "bloqueante", ' +
  '"hallazgo": string, "evidencia": string[]}';

// Canonical failure verdict (behavior 3, and every other failure mode).
// claimId stays empty (the driver never saw one); the hallazgo is the exact
// machine-parseable string from the brief, evidencia empty for uniform shape.
function failureVerdict(call: AgentCall): Verdict {
  return {
    claimId: "",
    role: call.role,
    resultado: "sin-re-verificar",
    severidad: "bloqueante",
    hallazgo: "driver no devolvió veredicto estructurado",
    evidencia: [],
  };
}

// Prompt = rubric + material + the fenced JSON schema instruction, with the
// no-fetch phrase when the allowlist is empty (or the resolved allowlist
// otherwise), plus the retry suffix on the second attempt. The wording mirrors
// the rubric's output contract (exactly one fenced block) so the two prompts
// cannot drift apart.
function buildPrompt(call: AgentCall, retry: boolean): string {
  const parts = [
    call.rubric,
    call.material,
    "Responde con EXACTAMENTE un bloque fenced ```json que contenga un objeto " +
      `JSON con el schema Verdict: ${VERDICT_SCHEMA}`,
    "No escribas nada fuera de ese único bloque.",
  ];
  if (call.allowFetch.length === 0) {
    const blocked = call.blockedFetch ?? [];
    if (blocked.length > 0) {
      parts.push(`No hagas fetch a: ${blocked.join(", ")}. ${BLOCKED_FETCH_SUFFIX}`);
    } else {
      parts.push(NO_FETCH_PHRASE);
    }
  } else {
    parts.push(`Puedes hacer fetch únicamente a: ${call.allowFetch.join(", ")}`);
  }
  if (retry) parts.push(RETRY_SUFFIX);
  return parts.join("\n\n");
}

// Fenced ```json blocks, tolerating trailing spaces and CRLF on the fences.
const FENCED_JSON = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;

// Returns the LAST fenced ```json block's content on stdout, or undefined.
function lastFencedJson(stdout: string): string | undefined {
  let last: string | undefined;
  for (const match of stdout.matchAll(FENCED_JSON)) last = match[1] ?? "";
  return last;
}

// Fallback for a backend that answers with a bare JSON object: scan stdout
// backwards and return the last balanced `{…}` substring that parses as a JSON
// object. Deliberately simple (no string/escape tracking): the Verdict schema
// is flat, and a wrong candidate is simply rejected by parseVerdict and retried.
function lastBareJsonObject(stdout: string): string | undefined {
  let end = stdout.lastIndexOf("}");
  while (end >= 0) {
    let depth = 0;
    for (let start = end; start >= 0; start -= 1) {
      const char = stdout[start];
      if (char === "}") depth += 1;
      else if (char === "{") {
        depth -= 1;
        if (depth === 0) {
          const candidate = stdout.slice(start, end + 1);
          try {
            const value: unknown = JSON.parse(candidate);
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
              return candidate;
            }
          } catch {
            // not JSON: keep scanning for an earlier candidate
          }
          break;
        }
      }
    }
    end = end === 0 ? -1 : stdout.lastIndexOf("}", end - 1);
  }
  return undefined;
}

// Structured-output extraction: a fenced block always wins; a bare JSON object
// is the documented fallback, and plain prose is discarded (parse failure).
function extractVerdictJson(stdout: string): string | undefined {
  const fenced = lastFencedJson(stdout);
  return fenced !== undefined ? fenced : lastBareJsonObject(stdout);
}

// Literal sets accepted by the manual Verdict validation (defined with the
// schema in types.ts; re-exported above for existing importers).

// Manual field validation of Verdict (no ajv, no schema lib): every required
// field present with the right primitive type / literal value. A `role` that
// differs from call.role is still valid here; behavior 4 overwrites it with
// `call.role` below, so the verdict's role is never the agent's to decide.
function parseVerdict(json: string, role: string): Verdict | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.claimId !== "string") return undefined;
  if (typeof record.role !== "string") return undefined;
  if (typeof record.resultado !== "string" || !RESULTADOS.has(record.resultado)) {
    return undefined;
  }
  if (typeof record.severidad !== "string" || !SEVERIDADES.has(record.severidad)) {
    return undefined;
  }
  if (typeof record.hallazgo !== "string") return undefined;
  const evidencia = record.evidencia;
  if (!Array.isArray(evidencia)) return undefined;
  if (evidencia.some((item) => typeof item !== "string")) return undefined;

  const verdict: Verdict = {
    claimId: record.claimId,
    role: record.role,
    resultado: record.resultado as Verdict["resultado"],
    severidad: record.severidad as Verdict["severidad"],
    hallazgo: record.hallazgo,
    evidencia: evidencia as string[],
  };
  // Behavior 4: the returned role is never trusted over the call's role.
  verdict.role = role;
  return verdict;
}

// argv for one `opencode run` call. The model flag is prepended only when a
// model was requested, so the no-model argv stays exactly `["run", prompt]`.
// `provider/model` is opencode's own convention: the harness validates only
// that the value is non-empty and not flag-looking, then passes it verbatim.
export function buildRunArgs(
  model: string | undefined,
  prompt: string,
): string[] {
  return ["run", ...(model ? ["--model", model] : []), prompt];
}

// Grace period between SIGTERM and SIGKILL on abort. A backend that traps
// SIGTERM still dies; the escalation timer is cleared on close, so a normal
// SIGTERM death never holds the process open.
export const KILL_GRACE_MS = 5_000;

// Real `opencode run <prompt>` subprocess via node:child_process, with an
// injectable kill grace for tests. Spawn errors reject; the driver catches them
// above. On abort (orchestrator per-call timeout or SIGINT) the child gets
// SIGTERM and, if it is still alive after `graceMs`, SIGKILL. The child is also
// detached from the event loop so even a backend that ignores both signals
// cannot keep the CLI alive: the orchestrator has already recorded the timeout.
// The piped stdout closes with the child and this promise resolves on close.
export function makeRunProcess(graceMs: number = KILL_GRACE_MS): SpawnFn {
  return (cmd, args, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, graceMs);
          // Deliberately NOT unref'd: if the backend traps SIGTERM, the timer
          // must keep the CLI alive until SIGKILL lands. `close` clears it.
        }
        child.unref();
        const pipe = child.stdout as unknown as { unref?: () => void } | null;
        pipe?.unref?.();
      };
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (error) => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, code: code ?? 1 });
      });
    });
}

// Primary implementation used by the CLI (default 5 s kill grace).
export const defaultRunProcess: SpawnFn = makeRunProcess();

// Attempts: 1 normal, at most 1 retry when the output can't be parsed/validated
// (behavior 3). Spawn failures (rejected runProcess or non-zero exit) do not
// retry: retries exist only for polluted stdout, and `calls` always matches
// real spawns exactly.
export function opencodeDriver(
  cmd: string = "opencode",
  runProcess: SpawnFn = defaultRunProcess,
): Driver {
  return async (call: AgentCall): Promise<AgentResult> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Once the orchestrator has aborted this call (timeout/SIGINT), spawning
      // the retry would be a second orphan no one is waiting for. `calls`
      // still reports the attempts that really happened.
      if (attempt > 0 && call.signal?.aborted) {
        return { verdicts: [failureVerdict(call)], calls: attempt };
      }
      // `calls` counts every real runProcess invocation, so it is one per
      // attempt (1 normal, 2 with the single retry) — exact for the Budget.
      let stdout: string;
      let code: number;
      try {
        ({ stdout, code } = await runProcess(
          cmd,
          buildRunArgs(call.model, buildPrompt(call, attempt > 0)),
          call.signal,
        ));
      } catch {
        return { verdicts: [failureVerdict(call)], calls: 1 };
      }
      if (code !== 0) {
        return { verdicts: [failureVerdict(call)], calls: 1 };
      }
      const json = extractVerdictJson(stdout);
      if (json !== undefined) {
        const verdict = parseVerdict(json, call.role);
        if (verdict !== undefined) return { verdicts: [verdict], calls: attempt + 1 };
      }
    }
    return { verdicts: [failureVerdict(call)], calls: 2 };
  };
}
