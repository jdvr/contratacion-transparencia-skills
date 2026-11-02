// v1 driver: runs one `opencode run <prompt>` subprocess per call and extracts
// a structured Verdict from its stdout. The driver NEVER throws: every failure
// mode (spawn error, non-zero exit, unparseable/invalid output after the single
// retry) degrades to a Verdict with resultado "sin-re-verificar" and severity
// "bloqueante" (see docs/superpowers/specs/2026-10-31-evaluador-design.md).
import { spawn } from "node:child_process";
import type {
  AgentCall,
  AgentResult,
  Driver,
  SpawnFn,
  Verdict,
} from "./types.js";

// Injected when the claim cites nothing fetchable (allowlist lives in Task 6).
const NO_FETCH_PHRASE = "No hagas fetch: marca resultado sin-re-verificar";
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
    parts.push(NO_FETCH_PHRASE);
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

// Literal sets accepted by the manual Verdict validation. Exported so the
// orchestrator's cross-suite test can pin them against every rubric (Task 6
// carry: rubric/driver schema drift must not silently degrade every verdict).
export const RESULTADOS = new Set(["ok", "problema", "sin-re-verificar"]);
export const SEVERIDADES = new Set(["aviso", "bloqueante"]);

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

// Primary implementation: real `opencode run <prompt>` subprocess via
// node:child_process. Spawn errors reject; the driver catches them above.
// Exported so the focused test can exercise the real kill-on-abort path.
// On abort (orchestrator per-call timeout) the child is killed and detached
// from the event loop, so a hung backend cannot outlive the CLI; the piped
// stdout closes with the child and this promise resolves on the close event.
export const defaultRunProcess: SpawnFn = (cmd, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    const onAbort = (): void => {
      child.kill();
      // Detach so even a backend that ignores SIGTERM cannot keep Node alive
      // after the orchestrator has already recorded the timeout verdict.
      child.unref();
      const pipe = child.stdout as unknown as { unref?: () => void } | null;
      pipe?.unref?.();
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, code: code ?? 1 });
    });
  });

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
      // `calls` counts every real runProcess invocation, so it is one per
      // attempt (1 normal, 2 with the single retry) — exact for the Budget.
      let stdout: string;
      let code: number;
      try {
        ({ stdout, code } = await runProcess(
          cmd,
          ["run", buildPrompt(call, attempt > 0)],
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
