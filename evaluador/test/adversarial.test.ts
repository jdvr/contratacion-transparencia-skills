// Tests for Task 8: resumable state (`.evaluador/state.json`) and the phase
// orchestration `runEval()`. Every driver here is injected and fake — no real
// `opencode` binary, no network, no subprocess — and every tempdir is removed
// in `afterAll`. Fixtures are generated (fictitious) and pass the structural
// gate, so each scenario exercises orchestration, not the gate's rejections.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DRIVER_TIMEOUT_MS,
  loadState,
  runEval,
  saveState,
} from "../src/adversarial.js";
import type { EvaluatorState, RunEvalOptions } from "../src/adversarial.js";
import { main } from "../src/cli.js";
import { RESULTADOS, SEVERIDADES } from "../src/driver/opencode.js";
import type { AgentCall, AgentResult, Driver, Verdict } from "../src/driver/types.js";
import { DEFAULT_ROLES, RUBRIC_VERSION, rubricFor } from "../src/rubric.js";
import type { RoleId } from "../src/rubric.js";
import { contentHash } from "../src/state.js";

// ── generated fixtures ────────────────────────────────────────────────────

// A complete VERIFICADO claim that passes the structural gate; overrides can
// drop fields (JSON.stringify drops `undefined`), so the same fixture feeds
// HIPÓTESIS / NO CONCLUYENTE cases too.
function baseClaim(id: string): Record<string, unknown> {
  return {
    id,
    afirmacion: `afirmación ficticia ${id} (dato generado)`,
    cifra: "1.000,00 €",
    fuente: "Fuente Generada de Prueba",
    url: "https://datos.canarias.es/ejemplo-generado",
    fecha_dato: "2025",
    fecha_consulta: "2026-11-01",
    criterio: "criterio ficticio del total para la prueba",
    filas_traidas: 5,
    conteo_declarado: 10,
    banderas: [],
    dedup: false,
    etiqueta: "VERIFICADO",
    licencia: "Fuente: Datos Generados (fixture de prueba)",
  };
}

// The three-claim fixture: one per honest label family (all gate-valid).
function threeClaims(): Array<Record<string, unknown>> {
  return [
    baseClaim("claim-c1"),
    {
      ...baseClaim("claim-c2"),
      etiqueta: "HIPÓTESIS",
      licencia: undefined,
    },
    {
      ...baseClaim("claim-c3"),
      cifra: undefined,
      filas_traidas: undefined,
      conteo_declarado: undefined,
      licencia: undefined,
      etiqueta: "NO CONCLUYENTE",
    },
  ];
}

function reportMd(claims: Array<Record<string, unknown>>): string {
  const blocks = claims.map((claim) => "```json\n" + JSON.stringify(claim, null, 2) + "\n```");
  return ["# Reporte de prueba (datos generados)", ...blocks].join("\n\n") + "\n";
}

// ── fake drivers ──────────────────────────────────────────────────────────

function okVerdict(call: AgentCall, overrides: Partial<Verdict> = {}): Verdict {
  return {
    claimId: "", // the driver never knows it; runEval must assign the real id
    role: call.role,
    resultado: "ok",
    severidad: "aviso",
    hallazgo: "",
    evidencia: [],
    ...overrides,
  };
}

function countingDriver(respond: (call: AgentCall) => AgentResult): {
  driver: Driver;
  calls: AgentCall[];
} {
  const calls: AgentCall[] = [];
  const driver: Driver = async (call) => {
    calls.push(call);
    return respond(call);
  };
  return { driver, calls };
}

function okDriver(): { driver: Driver; calls: AgentCall[] } {
  return countingDriver((call) => ({ verdicts: [okVerdict(call)], calls: 1 }));
}

// ── tempdir sessions ──────────────────────────────────────────────────────

const tempRoots = new Set<string>();

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evaluador-adversarial-test-"));
  tempRoots.add(dir);
  return dir;
}

interface Session {
  cwd: string;
  reportPath: string;
}

function newSession(claims = threeClaims()): Session {
  const cwd = newTempDir();
  const reportPath = join(cwd, "reporte.md");
  writeFileSync(reportPath, reportMd(claims));
  return { cwd, reportPath };
}

function evalOpts(
  session: Session,
  driver: Driver,
  extra: Partial<RunEvalOptions> = {},
): RunEvalOptions {
  return {
    reportPath: session.reportPath,
    cwd: session.cwd,
    budget: 20,
    driver,
    ...extra,
  };
}

function stateDir(session: Session): string {
  return join(session.cwd, ".evaluador");
}

function recordedClaim(state: EvaluatorState, id: string) {
  const found = state.claims.find((rc) => rc.claim.id === id);
  if (found === undefined) throw new Error(`missing recorded claim ${id}`);
  return found;
}

// Silences CLI output so the suite stays pristine.
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ── runEval semantics ─────────────────────────────────────────────────────

describe("runEval", () => {
  it("(a) first run: 3 claims × 4 roles = 12 driver calls, code 0", async () => {
    const session = newSession();
    const { driver, calls } = okDriver();

    const result = await runEval(evalOpts(session, driver));

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(12);
    expect(result.state.claims).toHaveLength(3);
    for (const rc of result.state.claims) {
      expect(rc.verdicts).toHaveLength(DEFAULT_ROLES.length);
      expect(rc.verdicts.map((v) => v.role).sort()).toEqual([...DEFAULT_ROLES].sort());
      for (const verdict of rc.verdicts) {
        expect(verdict.claimId).toBe(rc.claim.id); // assignment carried from Task 5
      }
    }
    expect(result.state.petitions).toBe(12);
    expect(result.state.rubricVersion).toBe(RUBRIC_VERSION);
    expect(result.state.reporte).toBe(
      contentHash(result.state.claims.map((rc) => rc.claim)),
    );
    // Persisted to <cwd>/.evaluador/state.json, re-readable by loadState.
    expect(loadState(stateDir(session))).toEqual(result.state);

    // The call carries the role rubric, serialized claim material and allowlist.
    for (const call of calls) {
      expect(call.rubric).toBe(rubricFor(call.role as RoleId));
      expect(call.material).toContain('"afirmacion"');
      expect(call.allowFetch).toEqual(["https://datos.canarias.es/ejemplo-generado"]);
    }
  });

  it("(b) second run over an unchanged report: zero driver calls", async () => {
    const session = newSession();
    const first = await runEval(evalOpts(session, okDriver().driver));

    const { driver, calls } = okDriver();
    const second = await runEval(evalOpts(session, driver));

    expect(second.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(second.state.claims).toEqual(first.state.claims);
    expect(second.state.petitions).toBe(12); // nothing spent this run
  });

  it("(c) changing one claim body re-reviews only that claim (4 calls)", async () => {
    const session = newSession();
    const first = await runEval(evalOpts(session, okDriver().driver));

    const changed = threeClaims();
    changed[1] = { ...(changed[1] ?? {}), afirmacion: "cuerpo cambiado (dato generado)" };
    writeFileSync(session.reportPath, reportMd(changed));

    const { driver, calls } = okDriver();
    const second = await runEval(evalOpts(session, driver));

    expect(second.code).toBe(0);
    expect(calls).toHaveLength(4);
    const oldC2 = recordedClaim(first.state, "claim-c2");
    const newC2 = recordedClaim(second.state, "claim-c2");
    expect(newC2.hash).not.toBe(oldC2.hash);
    expect(newC2.claim.afirmacion).toBe("cuerpo cambiado (dato generado)");
    expect(newC2.verdicts).toHaveLength(4);
    expect(second.state.petitions).toBe(16);
  });

  it("(d) a bloqueante verdict in any role ⇒ code 1", async () => {
    const session = newSession();
    const { driver } = countingDriver((call) =>
      call.role === "falsificador"
        ? {
            verdicts: [
              okVerdict(call, {
                resultado: "problema",
                severidad: "bloqueante",
                hallazgo: "fallo ficticio bloqueante",
              }),
            ],
            calls: 1,
          }
        : { verdicts: [okVerdict(call)], calls: 1 },
    );

    const result = await runEval(evalOpts(session, driver));

    expect(result.code).toBe(1);
    expect(
      result.state.claims.some((rc) =>
        rc.verdicts.some((v) => v.severidad === "bloqueante"),
      ),
    ).toBe(true);
  });

  it("(e) resume from recheck: only the marked claim is re-reviewed, code 0", async () => {
    const session = newSession();
    const failing = countingDriver((call) => ({
      verdicts: [
        call.material.includes("claim-c2")
          ? okVerdict(call, {
              resultado: "sin-re-verificar",
              severidad: "bloqueante",
              hallazgo: "no re-verificado en la primera pasada",
            })
          : okVerdict(call),
      ],
      calls: 1,
    }));

    const first = await runEval(evalOpts(session, failing.driver));
    expect(first.code).toBe(1);
    expect(recordedClaim(first.state, "claim-c2").recheck).toBe("sin-re-verificar");

    const { driver, calls } = okDriver();
    const second = await runEval(evalOpts(session, driver));

    expect(second.code).toBe(0);
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.material).toContain("claim-c2");
    expect(recordedClaim(second.state, "claim-c2").recheck).toBeUndefined();
  });

  it("noCache forces a complete re-review (12 calls) even with state + cache", async () => {
    const session = newSession();
    await runEval(evalOpts(session, okDriver().driver));

    const { driver, calls } = okDriver();
    const result = await runEval(evalOpts(session, driver, { noCache: true }));

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(12);
  });

  it("gate failure ⇒ code 2, no state written, driver never called", async () => {
    const session = newSession([{ ...baseClaim("claim-broken"), cifra: undefined }]);
    const { driver, calls } = okDriver();

    const result = await runEval(evalOpts(session, driver));

    expect(result.code).toBe(2);
    expect(result.gaps).toContainEqual({
      claim: "claim-broken",
      campo: "cifra",
      razon: "falta",
    });
    expect(calls).toHaveLength(0);
    expect(loadState(stateDir(session))).toBeNull();
  });

  it("assigns every verdict of a multi-verdict call to the claim and role", async () => {
    const session = newSession([baseClaim("claim-multi")]);
    const driver: Driver = async (call) => ({
      verdicts: [
        okVerdict(call, { claimId: "ignored-1" }),
        okVerdict(call, {
          claimId: "ignored-2",
          resultado: "problema",
          severidad: "aviso",
          hallazgo: "aviso ficticio",
        }),
      ],
      calls: 1,
    });

    const result = await runEval({
      ...evalOpts(session, driver),
      roles: ["contadores"],
    });

    expect(result.code).toBe(0); // warnings do not block closure
    const verdicts = result.state.claims[0]?.verdicts ?? [];
    expect(verdicts).toHaveLength(2);
    for (const verdict of verdicts) {
      expect(verdict.claimId).toBe("claim-multi");
      expect(verdict.role).toBe("contadores");
    }
  });

  it("driver timeout ⇒ declared sin-re-verificar verdict, code 1, never throws", async () => {
    const session = newSession([baseClaim("claim-timeout")]);
    let calls = 0;
    const never: Driver = () => {
      calls += 1;
      return new Promise<AgentResult>(() => {});
    };

    const result = await runEval({
      ...evalOpts(session, never),
      roles: ["contadores"],
      timeoutMs: 20,
    });

    expect(calls).toBe(1);
    expect(result.code).toBe(1);
    expect(DRIVER_TIMEOUT_MS).toBe(300_000);
    const rc = recordedClaim(result.state, "claim-timeout");
    expect(rc.recheck).toBe("sin-re-verificar");
    expect(rc.verdicts).toEqual([
      {
        claimId: "claim-timeout",
        role: "contadores",
        resultado: "sin-re-verificar",
        severidad: "bloqueante",
        hallazgo: "driver timeout (without response in 300 s)",
        evidencia: [],
      },
    ]);
  });
});

// ── state IO ──────────────────────────────────────────────────────────────

describe("state IO", () => {
  it("saveState/loadState round-trip; missing, corrupt or wrong-version ⇒ null", () => {
    const dir = newTempDir();
    const state: EvaluatorState = {
      version: 1,
      reporte: "hash-ficticio",
      rubricVersion: RUBRIC_VERSION,
      claims: [],
      petitions: 0,
      updatedAt: "2026-11-02T00:00:00.000Z",
    };

    saveState(dir, state);
    expect(loadState(dir)).toEqual(state);
    expect(loadState(join(newTempDir(), "absent"))).toBeNull();

    const corrupt = newTempDir();
    writeFileSync(join(corrupt, "state.json"), "{not json");
    expect(loadState(corrupt)).toBeNull();

    const wrongVersion = newTempDir();
    writeFileSync(
      join(wrongVersion, "state.json"),
      JSON.stringify({ ...state, version: 2 }),
    );
    expect(loadState(wrongVersion)).toBeNull();
  });
});

// ── rubric ↔ driver schema drift (Task 6 carry) ───────────────────────────

describe("rubric and driver schema agree", () => {
  it("every role rubric mentions the three resultado and two severidad values", () => {
    expect([...RESULTADOS].sort()).toEqual(["ok", "problema", "sin-re-verificar"]);
    expect([...SEVERIDADES].sort()).toEqual(["aviso", "bloqueante"]);
    for (const role of DEFAULT_ROLES) {
      const rubric = rubricFor(role);
      for (const value of RESULTADOS) {
        expect(rubric, `rubric ${role} must mention resultado ${value}`).toContain(value);
      }
      for (const value of SEVERIDADES) {
        expect(rubric, `rubric ${role} must mention severidad ${value}`).toContain(value);
      }
    }
  });
});

// ── CLI wiring ────────────────────────────────────────────────────────────

describe("cli eval wiring", () => {
  it("maps code 0 to exit 0 and plumbs --no-cache", async () => {
    const session = newSession();
    const first = okDriver();
    expect(
      await quietly(() =>
        main(["eval", session.reportPath], { driver: first.driver, cwd: session.cwd }),
      ),
    ).toBe(0);
    expect(first.calls).toHaveLength(12);

    const second = okDriver();
    expect(
      await quietly(() =>
        main(["eval", session.reportPath, "--no-cache"], {
          driver: second.driver,
          cwd: session.cwd,
        }),
      ),
    ).toBe(0);
    expect(second.calls).toHaveLength(12);
  });

  it("maps a bloqueante verdict to exit 1", async () => {
    const session = newSession();
    const driver: Driver = async (call) => ({
      verdicts: [
        okVerdict(call, {
          resultado: "problema",
          severidad: "bloqueante",
          hallazgo: "fallo ficticio",
        }),
      ],
      calls: 1,
    });

    const code = await quietly(() =>
      main(["eval", session.reportPath], { driver, cwd: session.cwd }),
    );
    expect(code).toBe(1);
  });

  it("usage and unreadable-file errors stay exit 3", async () => {
    expect(await quietly(() => main(["eval"]))).toBe(3);
    expect(
      await quietly(() => main(["eval", join(newTempDir(), "que-no-existe.md")])),
    ).toBe(3);
  });
});

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});
