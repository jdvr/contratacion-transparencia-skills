// Tests for the opencode subprocess driver, exercising the runProcess injection
// seam ONLY (no real `opencode` binary, no network, no filesystem). Each fake
// `runProcess` scripts the stdout segments it returns and records every spawn
// (cmd + args) so tests can assert on prompt contents and spawn counts.
import { describe, expect, it } from "vitest";
import { opencodeDriver } from "../src/driver/opencode.js";
import type { AgentCall, SpawnFn } from "../src/driver/types.js";

const NO_FETCH_PHRASE = "No hagas fetch: marca resultado sin-re-verificar";
const RETRY_SUFFIX = "SOLO JSON, sin texto fuera del bloque";

// Scripted fake: each spawn consumes the next segment; prompts are recorded.
function scriptedRun(script: Array<{ stdout: string; code: number }>): {
  run: SpawnFn;
  calls: Array<{ cmd: string; args: string[] }>;
  prompts: string[];
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: SpawnFn = async (cmd, args) => {
    calls.push({ cmd, args });
    prompts.push(args[1] ?? "");
    const segment = script[calls.length - 1];
    if (segment === undefined) throw new Error("unexpected extra spawn");
    return segment;
  };
  const prompts: string[] = [];
  return { run, calls, prompts };
}

// Rejecting fake: simulates the real binary being missing/unspawnable.
function rejectingRun(error: Error): { run: SpawnFn; calls: string[] } {
  const calls: string[] = [];
  const run: SpawnFn = async () => {
    calls.push("spawn");
    throw error;
  };
  return { run, calls };
}

const baseCall: AgentCall = {
  role: "verificador-cifras",
  rubric: "RÚBRICA de prueba (ficticia)",
  material: "MATERIAL de prueba (dato generado)",
  allowFetch: ["https://example.com/permitida"],
};

function verdictJson(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    claimId: "claim-driver-test",
    role: "verificador-cifras",
    resultado: "problema",
    severidad: "aviso",
    hallazgo: "hallazgo ficticio de prueba",
    evidencia: ["evidencia-1", "evidencia-2"],
  };
  for (const [key, value] of Object.entries(overrides)) base[key] = value;
  return "```json\n" + JSON.stringify(base, null, 2) + "\n```";
}

function fenced(text: string): string {
  return "```json\n" + text + "\n```";
}

describe("opencode driver", () => {
  it("(a) parses the LAST fenced json block, fields intact, calls: 1", async () => {
    const { run, calls } = scriptedRun([
      {
        // Earlier blocks (valid or not) must be ignored: LAST one wins.
        stdout:
          fenced("esto no es json {") +
          "\nprose intermedia\n" +
          verdictJson({ claimId: "claim-ultimo" }),
        code: 0,
      },
    ]);
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("opencode");
    expect(calls[0]?.args[0]).toBe("run");
    expect(result.calls).toBe(1);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]).toEqual({
      claimId: "claim-ultimo",
      role: "verificador-cifras",
      resultado: "problema",
      severidad: "aviso",
      hallazgo: "hallazgo ficticio de prueba",
      evidencia: ["evidencia-1", "evidencia-2"],
    });
  });

  it("(b) garbage stdout → one retry with the stricter suffix → valid, calls: 2", async () => {
    const { run, calls, prompts } = scriptedRun([
      { stdout: "salida sin ningún bloque json ```", code: 0 },
      { stdout: verdictJson(), code: 0 },
    ]);
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(calls).toHaveLength(2);
    expect(result.calls).toBe(2);
    expect(result.verdicts[0]?.resultado).toBe("problema");
    expect(prompts[1]?.includes(RETRY_SUFFIX)).toBe(true);
    expect(prompts[0]?.includes(RETRY_SUFFIX)).toBe(false);
  });

  it("(c) always garbage → sin-re-verificar/bloqueante verdict, exact hallazgo, never throws", async () => {
    const { run } = scriptedRun([
      { stdout: "nope", code: 0 },
      { stdout: fenced('{"claimId": 42}'), code: 0 },
    ]);
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(result.calls).toBe(2);
    expect(result.verdicts).toEqual([
      {
        claimId: "",
        role: "verificador-cifras",
        resultado: "sin-re-verificar",
        severidad: "bloqueante",
        hallazgo: "driver no devolvió veredicto estructurado",
        evidencia: [],
      },
    ]);
  });

  it("(d) a parsed verdict whose role differs from call.role is overwritten", async () => {
    const { run } = scriptedRun([{ stdout: verdictJson({ role: "otro-role" }), code: 0 }]);
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(result.calls).toBe(1);
    expect(result.verdicts[0]?.role).toBe("verificador-cifras");
  });

  it("(e) allowFetch: [] injects the no-fetch phrase into the prompt", async () => {
    const { run, prompts } = scriptedRun([
      { stdout: verdictJson({ allowProbe: true }), code: 0 },
    ]);
    await opencodeDriver("opencode", run)({ ...baseCall, allowFetch: [] });

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain(NO_FETCH_PHRASE);
    expect(prompt).toContain(baseCall.rubric);
    expect(prompt).toContain(baseCall.material);

    // Contrast: with a non-empty allowlist the phrase must NOT appear.
    const { run: run2, prompts: prompts2 } = scriptedRun([{ stdout: verdictJson(), code: 0 }]);
    await opencodeDriver("opencode", run2)(baseCall);
    expect(prompts2[0]).not.toContain(NO_FETCH_PHRASE);
  });

  it("(f) runProcess rejecting (spawn failure) never throws: error verdict, calls: 1", async () => {
    const { run, calls } = rejectingRun(new Error("ENOENT: spawn opencode"));
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(calls).toHaveLength(1);
    expect(result.calls).toBe(1);
    expect(result.verdicts[0]?.resultado).toBe("sin-re-verificar");
    expect(result.verdicts[0]?.severidad).toBe("bloqueante");
    expect(result.verdicts[0]?.role).toBe("verificador-cifras");
  });

  it("(g) non-zero exit code is a failure verdict (no retry), calls: 1", async () => {
    const { run, calls } = scriptedRun([{ stdout: "partial output", code: 1 }]);
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(calls).toHaveLength(1);
    expect(result.calls).toBe(1);
    expect(result.verdicts[0]?.resultado).toBe("sin-re-verificar");
    expect(result.verdicts[0]?.severidad).toBe("bloqueante");
    expect(result.verdicts[0]?.hallazgo).toBe("driver no devolvió veredicto estructurado");
  });

  it("(h) custom cmd string is used verbatim as the spawn command", async () => {
    const { run, calls } = scriptedRun([{ stdout: verdictJson(), code: 0 }]);
    await opencodeDriver("mi-opencode-build", run)(baseCall);
    expect(calls[0]?.cmd).toBe("mi-opencode-build");
  });
});
