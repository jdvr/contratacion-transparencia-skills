// Tests for the opencode subprocess driver, exercising the runProcess injection
// seam ONLY (no real `opencode` binary, no network, no filesystem). Each fake
// `runProcess` scripts the stdout segments it returns and records every spawn
// (cmd + args) so tests can assert on prompt contents and spawn counts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRunArgs,
  defaultRunProcess,
  opencodeDriver,
} from "../src/driver/opencode.js";
import type { AgentCall, SpawnFn } from "../src/driver/types.js";
import { DEFAULT_ROLES, rubricFor } from "../src/rubric.js";

const NO_FETCH_PHRASE = "No hagas fetch: marca resultado sin-re-verificar";
const RETRY_SUFFIX = "SOLO el bloque fenced ```json, sin texto fuera de él";

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

function stripFence(fencedText: string): string {
  return fencedText.replace(/^```json\n/, "").replace(/\n```$/, "");
}

// Polling helpers for the real-subprocess abort test (fast, hermetic).
async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within 2 s");
}

function readPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false; // still alive
  } catch {
    return true; // ESRCH: gone
  }
}

describe("opencode driver", () => {
  it("builds the run argv with the model only when one was requested", () => {
    expect(buildRunArgs("opencode-go/deepseek-v4.1-flash", "PROMPT")).toEqual([
      "run",
      "--model",
      "opencode-go/deepseek-v4.1-flash",
      "PROMPT",
    ]);
    // No model: the historical argv is preserved byte for byte.
    expect(buildRunArgs(undefined, "PROMPT")).toEqual(["run", "PROMPT"]);
  });

  it("passes call.model to the spawned argv", async () => {
    const { run, calls } = scriptedRun([{ stdout: verdictJson(), code: 0 }]);
    await opencodeDriver("opencode", run)({
      ...baseCall,
      model: "opencode-go/deepseek-v4.1-flash",
    });

    expect(calls[0]?.args.slice(0, 3)).toEqual([
      "run",
      "--model",
      "opencode-go/deepseek-v4.1-flash",
    ]);
    expect(calls[0]?.args[3]).toContain(baseCall.rubric);
  });

  it("(a2) accepts a bare JSON object with no fence, calls: 1 (no retry)", async () => {
    const { run, calls } = scriptedRun([
      { stdout: JSON.stringify(JSON.parse(stripFence(verdictJson()))), code: 0 },
    ]);
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(calls).toHaveLength(1);
    expect(result.calls).toBe(1);
    expect(result.verdicts[0]?.resultado).toBe("problema");
    expect(result.verdicts[0]?.claimId).toBe("claim-driver-test");
  });

  it("(a3) inline fenced block + bare JSON ⇒ the fenced block wins", async () => {
    const fencedOut = verdictJson({ claimId: "claim-fenced" });
    const bareOut = JSON.stringify(JSON.parse(stripFence(verdictJson({ claimId: "claim-bare" }))));
    const { run, calls } = scriptedRun([
      { stdout: `prosa inicial\n${fencedOut}\nprosa final\n${bareOut}\n`, code: 0 },
    ]);
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(calls).toHaveLength(1);
    expect(result.verdicts[0]?.claimId).toBe("claim-fenced");
  });

  it("(a4) valid JSON preceded by prose only ⇒ parses via the bare path", async () => {
    const bareOut = JSON.stringify(JSON.parse(stripFence(verdictJson({ claimId: "claim-prosa" }))));
    const { run, calls } = scriptedRun([
      { stdout: `Aquí está mi veredicto:\n${bareOut}\nGracias.\n`, code: 0 },
    ]);
    const result = await opencodeDriver("opencode", run)(baseCall);

    expect(calls).toHaveLength(1);
    expect(result.verdicts[0]?.claimId).toBe("claim-prosa");
  });

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

  it("(e2) an empty allowlist with blocked sources names them instead of denying a fetch", async () => {
    const blocked = ["https://evil.example/private", "https://unknown.example/x"];
    const { run, prompts } = scriptedRun([{ stdout: verdictJson(), code: 0 }]);
    await opencodeDriver("opencode", run)({
      ...baseCall,
      allowFetch: [],
      blockedFetch: blocked,
    });

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain(`No hagas fetch a: ${blocked.join(", ")}`);
    expect(prompt).toContain(
      "marca resultado sin-re-verificar y cita el dominio en hallazgo",
    );
    // Not the "there is nothing to fetch" wording: the claim DOES cite sources.
    expect(prompt).not.toContain(NO_FETCH_PHRASE);
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

  it("(i) abort kills the real spawned child and resolves the process promise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evaluador-driver-abort-"));
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    let pid: number | undefined;

    try {
      const pending = defaultRunProcess(
        process.execPath,
        [
          "-e",
          // Write our pid, then hang: only the abort path can end it.
          'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
          pidFile,
        ],
        controller.signal,
      );
      pid = await waitFor(() => readPid(pidFile));

      controller.abort();
      const result = await pending; // kill closes stdio: no hang, no orphan

      expect(result.code).not.toBe(0);
      await waitFor(() => (isDead(pid as number) ? true : undefined));
      expect(isDead(pid)).toBe(true);
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(j) an already-aborted signal kills the child immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await defaultRunProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      controller.signal,
    );
    expect(result.code).not.toBe(0);
  });

  // Consensus contract (Critical 1): the rubric and the driver must describe
  // the SAME output protocol. The rubric once demanded "no fences" while the
  // driver only read fenced blocks, so every real call would have retried and
  // then failed. Pin the shared wording here so the two cannot drift again.
  it("(k) rubric and driver agree on exactly one fenced ```json block", async () => {
    for (const role of DEFAULT_ROLES) {
      const rubric = rubricFor(role);
      expect(rubric).toContain("```json");
      expect(rubric.toLowerCase()).toContain("exactly one fenced");
      expect(rubric).not.toMatch(/no fences/i);
    }

    const { run, prompts } = scriptedRun([{ stdout: verdictJson(), code: 0 }]);
    await opencodeDriver("opencode", run)(baseCall);
    expect(prompts[0]).toContain("```json");
  });
});
