// Tests for Task 8: resumable state (`.evaluador/state.json`) and the phase
// orchestration `runEval()`. Every driver here is injected and fake — no real
// `opencode` binary, no network, no subprocess — and every tempdir is removed
// in `afterAll`. Fixtures are generated (fictitious) and pass the structural
// gate, so each scenario exercises orchestration, not the gate's rejections.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DRIVER_TIMEOUT_MS,
  loadState,
  runEval,
  saveState,
  unreviewedPairs,
} from "../src/adversarial.js";
import type { EvaluatorState, RecordedClaim, RunEvalOptions } from "../src/adversarial.js";
import { main } from "../src/cli.js";
import { RESULTADOS, SEVERIDADES } from "../src/driver/opencode.js";
import type { AgentCall, AgentResult, Driver, Verdict } from "../src/driver/types.js";
import { DEFAULT_ROLES, RUBRIC_VERSION, rubricFor } from "../src/rubric.js";
import type { RoleId } from "../src/rubric.js";
import { contentHash, writeFileAtomic } from "../src/state.js";

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

// The claim/role pairs left unbuilt by the budget: a claim carries the
// `presupuesto-agotado` marker and the pair simply has no verdict. This is the
// exact state representation Task 10 turns into issues.
function gapPairs(
  state: EvaluatorState,
  roles: readonly RoleId[],
): Array<{ claim: string; role: RoleId }> {
  return state.claims.flatMap((rc) =>
    rc.recheck === "presupuesto-agotado"
      ? roles
          .filter((role) => !rc.verdicts.some((verdict) => verdict.role === role))
          .map((role) => ({ claim: rc.claim.id, role }))
      : [],
  );
}

// `claim/role` pair of one driver call, read from the serialized material.
function callPair(call: AgentCall): string {
  const id = /"id": "([^"]+)"/.exec(call.material)?.[1] ?? "?";
  return `${id}/${call.role}`;
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

  it("threads the blocked sources of a claim into the driver call", async () => {
    const blockedUrl = "https://evil.example/dataset";
    const session = newSession([
      { ...baseClaim("claim-blocked"), url: blockedUrl },
    ]);
    const { driver, calls } = okDriver();

    await runEval({ ...evalOpts(session, driver), roles: ["contadores"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.allowFetch).toEqual([]);
    expect(calls[0]?.blockedFetch).toEqual([blockedUrl]);
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

  it("adopts cache hits after state.json is deleted (0 driver calls, code 0)", async () => {
    const session = newSession();
    const first = await runEval(evalOpts(session, okDriver().driver));
    expect(first.code).toBe(0);

    // The full run wrote both artifacts: the cache records the honest model.
    const cachePath = join(stateDir(session), "cache.json");
    const stored = JSON.parse(readFileSync(cachePath, "utf8")) as Record<
      string,
      Record<string, { verdict: Verdict; model: string; updatedAt: string }>
    >;
    const firstHash = first.state.claims[0]?.hash ?? "";
    expect(stored[firstHash]?.contadores?.model).toBe("opencode-run(v1)");

    // Removing the resumable state leaves the content-addressed cache as the
    // only source: every claim/role must be adopted from it.
    rmSync(join(stateDir(session), "state.json"));
    const { driver, calls } = okDriver();
    const second = await runEval(evalOpts(session, driver));

    expect(calls).toHaveLength(0);
    expect(second.code).toBe(0);
    expect(second.state.claims.map((rc) => rc.verdicts.length)).toEqual([4, 4, 4]);
  });

  it("labels the cache with the requested model and keeps the old label otherwise", async () => {
    const model = "opencode-go/deepseek-v4.1-flash";
    const session = newSession();
    const { driver, calls } = okDriver();

    const result = await runEval({ ...evalOpts(session, driver), model });

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(12);
    for (const call of calls) expect(call.model).toBe(model);

    const stored = JSON.parse(
      readFileSync(join(stateDir(session), "cache.json"), "utf8"),
    ) as Record<string, Record<string, { model: string }>>;
    const firstHash = result.state.claims[0]?.hash ?? "";
    expect(stored[firstHash]?.contadores?.model).toBe(
      `opencode-run(v1):${model}`,
    );
  });

  it("the same --model reuses the cache on a second run", async () => {
    const session = newSession();
    const model = "opencode-go/deepseek-v4.1-flash";
    const first = okDriver();
    expect(
      (await runEval({ ...evalOpts(session, first.driver), model })).code,
    ).toBe(0);
    expect(first.calls).toHaveLength(12);

    const second = okDriver();
    const result = await runEval({ ...evalOpts(session, second.driver), model });

    expect(result.code).toBe(0);
    expect(second.calls).toHaveLength(0); // same model: the cache serves it
  });

  it("changing --model invalidates the cache in both directions", async () => {
    const model = "opencode-go/deepseek-v4.1-flash";

    // default → --model: every claim/role pair is re-driven.
    const fromDefault = newSession();
    await runEval(evalOpts(fromDefault, okDriver().driver));
    const switched = okDriver();
    expect(
      (await runEval({ ...evalOpts(fromDefault, switched.driver), model })).code,
    ).toBe(0);
    expect(switched.calls).toHaveLength(12);

    // --model → default: the model-bearing verdicts do not serve the default run.
    const fromModel = newSession();
    await runEval({ ...evalOpts(fromModel, okDriver().driver), model });
    const back = okDriver();
    expect((await runEval(evalOpts(fromModel, back.driver))).code).toBe(0);
    expect(back.calls).toHaveLength(12);
  });

  it("treats a state with the pre-model hash composition as stale", async () => {
    const session = newSession();
    await runEval(evalOpts(session, okDriver().driver));

    // Simulate an older state: `hash` = contentHash({claim, rubricVersion}),
    // the composition before the model label joined it. Dropping the cache
    // leaves the state hash as the only possible source of a cache hit.
    const state = loadState(stateDir(session));
    if (state === null) throw new Error("state.json should exist");
    saveState(stateDir(session), {
      ...state,
      claims: state.claims.map((recorded) => ({
        ...recorded,
        hash: contentHash({
          claim: recorded.claim,
          rubricVersion: RUBRIC_VERSION,
        }),
      })),
    });
    rmSync(join(stateDir(session), "cache.json"));

    const { driver, calls } = okDriver();
    const result = await runEval(evalOpts(session, driver));

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(12); // hash mismatch ⇒ every pair re-driven
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

  it("(e2) a budget pause never downgrades a pending sin-re-verificar marker", async () => {
    const session = newSession();
    // Run 1: c2's roles return the canonical failure verdict, so the claim is
    // marked sin-re-verificar and those verdicts also land in the cache.
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

    // Run 2: budget 0, so c2's retry is paused before its first fresh verdict.
    // The marker must stay sin-re-verificar (a pause cannot weaken it).
    const paused = countingDriver((call) => ({ verdicts: [okVerdict(call)], calls: 1 }));
    const second = await runEval(evalOpts(session, paused.driver, { budget: 0 }));
    expect(second.code).toBe(1);
    expect(paused.calls).toHaveLength(0); // c1/c3 adopted free of petitions
    const stillFailing = recordedClaim(second.state, "claim-c2");
    expect(stillFailing.recheck).toBe("sin-re-verificar");
    expect(stillFailing.verdicts).toHaveLength(0); // the retry produced nothing

    // Run 3: normal budget. The pending sin-re-verificar must still bypass the
    // cache (which holds run 1's failure verdicts) and re-drive all 4 roles.
    const { driver, calls } = okDriver();
    const third = await runEval(evalOpts(session, driver));

    expect(third.code).toBe(0);
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.material).toContain("claim-c2");
    const resolved = recordedClaim(third.state, "claim-c2");
    expect(resolved.recheck).toBeUndefined();
    expect(resolved.verdicts).toHaveLength(4);
    expect(resolved.verdicts.every((verdict) => verdict.resultado === "ok")).toBe(true);
  });

  it("(e3) a sin-re-verificar retry re-drives only the failed roles and keeps prior blockers", async () => {
    const session = newSession([baseClaim("claim-c1")]);
    const first = countingDriver((call) => {
      if (call.role === "contadores") {
        return {
          verdicts: [
            okVerdict(call, {
              resultado: "problema",
              severidad: "bloqueante",
              hallazgo: "bloqueante ficticio de la primera pasada",
            }),
          ],
          calls: 1,
        };
      }
      if (call.role === "segunda-fuente") {
        return {
          verdicts: [
            okVerdict(call, {
              resultado: "sin-re-verificar",
              severidad: "bloqueante",
              hallazgo: "no re-verificado en la primera pasada",
            }),
          ],
          calls: 1,
        };
      }
      return { verdicts: [okVerdict(call)], calls: 1 };
    });

    const run1 = await runEval(evalOpts(session, first.driver));
    expect(run1.code).toBe(1);
    expect(recordedClaim(run1.state, "claim-c1").recheck).toBe("sin-re-verificar");

    // Run 2: every role returns ok. Only segunda-fuente (the role whose last
    // verdict was sin-re-verificar) may reach the driver.
    const second = okDriver();
    const run2 = await runEval(evalOpts(session, second.driver));

    expect(second.calls.map((call) => call.role)).toEqual(["segunda-fuente"]);
    expect(run2.code).toBe(1); // the prior blocker is still present
    const rc2 = recordedClaim(run2.state, "claim-c1");
    expect(rc2.recheck).toBeUndefined();
    const contadores = rc2.verdicts.find((verdict) => verdict.role === "contadores");
    expect(contadores?.resultado).toBe("problema");
    expect(contadores?.severidad).toBe("bloqueante");
    const segunda = rc2.verdicts.find((verdict) => verdict.role === "segunda-fuente");
    expect(segunda?.resultado).toBe("ok"); // replaced only for the re-driven role
    expect(rc2.verdicts).toHaveLength(4);

    // Run 3: state deleted, cache replay. The non-re-driven roles were never
    // overwritten, so the blocker survives from the cache instead of a stale
    // "ok" resurrecting a false closure.
    rmSync(join(stateDir(session), "state.json"));
    const third = okDriver();
    const run3 = await runEval(evalOpts(session, third.driver));

    expect(third.calls).toHaveLength(0);
    expect(run3.code).toBe(1);
    expect(
      recordedClaim(run3.state, "claim-c1").verdicts.find(
        (verdict) => verdict.role === "contadores",
      )?.severidad,
    ).toBe("bloqueante");
  });

  it("(e4) a subset --roles run keeps verdicts of roles it did not request", async () => {
    const session = newSession([baseClaim("claim-c1")]);
    await runEval(evalOpts(session, okDriver().driver));

    const { driver, calls } = countingDriver((call) => ({
      verdicts: [okVerdict(call)],
      calls: 1,
    }));
    const subset = await runEval({
      ...evalOpts(session, driver),
      roles: ["contadores"],
      noCache: true,
    });

    expect(calls.map((call) => call.role)).toEqual(["contadores"]);
    const rc = recordedClaim(subset.state, "claim-c1");
    expect(rc.verdicts.map((verdict) => verdict.role).sort()).toEqual(
      [...DEFAULT_ROLES].sort(),
    );
    // The accumulated role set is the union, so issue derivation never loses
    // the history of a role the subset run did not request.
    expect(subset.state.roles).toEqual([...DEFAULT_ROLES]);
  });

  it("(f) budget 5 of 12: five calls, gap pairs marked presupuesto-agotado, code 1", async () => {
    const session = newSession();
    const { driver, calls } = okDriver();

    const result = await runEval(evalOpts(session, driver, { budget: 5 }));

    expect(result.code).toBe(1);
    expect(calls).toHaveLength(5);
    // Documents execute claim by claim, role by role; the budget cuts mid-claim.
    expect(calls.map((call) => callPair(call))).toEqual([
      "claim-c1/contadores",
      "claim-c1/segunda-fuente",
      "claim-c1/falsificador",
      "claim-c1/metodico",
      "claim-c2/contadores",
    ]);
    expect(result.state.petitions).toBe(5);

    // The fully reviewed claim has no marker; the two cut claims carry the
    // declared gap, and only truly unbuilt pairs are missing verdicts.
    expect(recordedClaim(result.state, "claim-c1").recheck).toBeUndefined();
    expect(recordedClaim(result.state, "claim-c1").verdicts).toHaveLength(4);
    expect(recordedClaim(result.state, "claim-c2").recheck).toBe("presupuesto-agotado");
    expect(recordedClaim(result.state, "claim-c2").verdicts).toHaveLength(1);
    expect(recordedClaim(result.state, "claim-c3").recheck).toBe("presupuesto-agotado");
    expect(recordedClaim(result.state, "claim-c3").verdicts).toHaveLength(0);
    expect(gapPairs(result.state, DEFAULT_ROLES)).toEqual([
      { claim: "claim-c2", role: "segunda-fuente" },
      { claim: "claim-c2", role: "falsificador" },
      { claim: "claim-c2", role: "metodico" },
      { claim: "claim-c3", role: "contadores" },
      { claim: "claim-c3", role: "segunda-fuente" },
      { claim: "claim-c3", role: "falsificador" },
      { claim: "claim-c3", role: "metodico" },
    ]);
    // The pause is resumable: the declared gap is persisted, not in memory only.
    expect(loadState(stateDir(session))).toEqual(result.state);
  });

  it("(g) re-run with enough budget reviews exactly the seven gap pairs, code 0", async () => {
    const session = newSession();
    const first = await runEval(evalOpts(session, okDriver().driver, { budget: 5 }));
    expect(first.code).toBe(1);

    const { driver, calls } = okDriver();
    const second = await runEval(evalOpts(session, driver, { budget: 20 }));

    expect(second.code).toBe(0);
    expect(calls).toHaveLength(7);
    expect(calls.map((call) => callPair(call))).toEqual([
      "claim-c2/segunda-fuente",
      "claim-c2/falsificador",
      "claim-c2/metodico",
      "claim-c3/contadores",
      "claim-c3/segunda-fuente",
      "claim-c3/falsificador",
      "claim-c3/metodico",
    ]);
    expect(second.state.petitions).toBe(12); // 5 + 7 actual driver calls
    expect(gapPairs(second.state, DEFAULT_ROLES)).toEqual([]);
    for (const rc of second.state.claims) {
      expect(rc.recheck).toBeUndefined();
      expect(rc.verdicts).toHaveLength(4);
    }
  });

  it("accepts a driver retry overshoot by one, then pauses the next pair", async () => {
    const session = newSession([baseClaim("claim-retry")]);
    const { driver, calls } = countingDriver((call) => ({
      verdicts: [okVerdict(call)],
      calls: 2, // normal call + the single structured-output retry
    }));

    const result = await runEval({
      ...evalOpts(session, driver, { budget: 1 }),
      roles: ["contadores", "metodico"],
    });

    expect(result.code).toBe(1);
    expect(calls).toHaveLength(1); // the accepted retry did not authorise more
    // The two real spawns stay declared in the manifest even though the
    // counter caps at max.
    expect(result.state.petitions).toBe(2);
    const rc = recordedClaim(result.state, "claim-retry");
    expect(rc.verdicts.map((verdict) => verdict.role)).toEqual(["contadores"]);
    expect(rc.recheck).toBe("presupuesto-agotado");
    expect(gapPairs(result.state, ["contadores", "metodico"])).toEqual([
      { claim: "claim-retry", role: "metodico" },
    ]);
  });

  it("noCache forces a complete re-review (12 calls) even with state + cache", async () => {    const session = newSession();
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

  it("SIGINT pauses with an interrumpido marker and the next run completes the missing pairs", async () => {
    const session = newSession(); // 3 claims × 4 roles = 12 pairs
    let calls = 0;
    let signalReached: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    const hanging: Driver = (call) => {
      calls += 1;
      if (calls === 6) {
        signalReached?.();
        return new Promise<AgentResult>(() => {});
      }
      return Promise.resolve({ verdicts: [okVerdict(call)], calls: 1 });
    };

    const pending = runEval(evalOpts(session, hanging));
    await reached;
    process.emit("SIGINT", "SIGINT");
    const paused = await pending;

    expect(calls).toBe(6); // five completed pairs + the aborted one
    expect(paused.code).toBe(1);

    const saved = loadState(stateDir(session));
    expect(saved).not.toBeNull();
    if (saved === null) throw new Error("state.json should exist after the pause");
    const c1 = recordedClaim(saved, "claim-c1");
    expect(c1.recheck).toBeUndefined();
    expect(c1.verdicts).toHaveLength(4);
    const c2 = recordedClaim(saved, "claim-c2");
    expect(c2.recheck).toBe("interrumpido");
    expect(c2.verdicts).toHaveLength(1); // contadores finished before the hang
    expect(saved.claims).toHaveLength(2); // claim-c3 was never reached

    // A fresh run adopts the completed pairs and drives only what is missing:
    // claim-c2's three remaining roles + claim-c3's four.
    const resumed = okDriver();
    const second = await runEval(evalOpts(session, resumed.driver));

    expect(second.code).toBe(0);
    expect(resumed.calls).toHaveLength(7);
    for (const rc of second.state.claims) {
      expect(rc.recheck).toBeUndefined();
      expect(rc.verdicts).toHaveLength(4);
    }
  });

  it("driver timeout ⇒ declared sin-re-verificar verdict, code 1, never throws", async () => {
    const session = newSession([baseClaim("claim-timeout")]);
    let calls = 0;
    let seenSignal: AbortSignal | undefined;
    const never: Driver = (call) => {
      calls += 1;
      seenSignal = call.signal;
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
    expect(seenSignal?.aborted).toBe(true); // timeout aborted the driver call
    const rc = recordedClaim(result.state, "claim-timeout");
    expect(rc.recheck).toBe("sin-re-verificar");
    expect(rc.verdicts).toEqual([
      {
        claimId: "claim-timeout",
        role: "contadores",
        resultado: "sin-re-verificar",
        severidad: "bloqueante",
        // The default 300_000 ms still renders the pinned "300 s" wording;
        // the injected 20 ms is reported as its real 0.02 s budget.
        hallazgo: "driver timeout (without response in 0.02 s)",
        evidencia: [],
      },
    ]);
  });

  it("drops an invalid verdict literal from state and re-drives that pair", async () => {
    const session = newSession([baseClaim("claim-corrupt")]);
    const roles: RoleId[] = ["contadores", "metodico"];
    const first = await runEval({ ...evalOpts(session, okDriver().driver), roles });
    expect(first.code).toBe(0);

    // Hand-edit the state with a literal the validator rejects.
    const statePath = join(stateDir(session), "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as EvaluatorState;
    const recorded = raw.claims[0];
    expect(recorded).toBeDefined();
    if (recorded === undefined) throw new Error("missing recorded claim");
    recorded.verdicts[0] = {
      ...recorded.verdicts[0],
      severidad: "critical",
    } as unknown as Verdict;
    writeFileSync(statePath, JSON.stringify(raw, null, 2) + "\n");
    rmSync(join(stateDir(session), "cache.json")); // force the driver path

    const { driver, calls } = okDriver();
    const second = await runEval({ ...evalOpts(session, driver), roles });

    expect(calls.map((call) => call.role)).toEqual(["contadores"]);
    expect(second.code).toBe(0);
    expect(second.state.claims[0]?.verdicts).toHaveLength(2);
    for (const verdict of second.state.claims[0]?.verdicts ?? []) {
      expect(["aviso", "bloqueante"]).toContain(verdict.severidad);
    }
  });

  it("a driver that returns no verdicts is a declared gap, never exit 0", async () => {
    const session = newSession([baseClaim("claim-empty")]);
    const driver: Driver = async () => ({ verdicts: [], calls: 1 });

    const result = await runEval({
      ...evalOpts(session, driver),
      roles: ["contadores"],
    });

    expect(result.code).toBe(1);
    const rc = recordedClaim(result.state, "claim-empty");
    expect(rc.recheck).toBe("sin-re-verificar");
    expect(rc.verdicts[0]).toMatchObject({
      resultado: "sin-re-verificar",
      hallazgo: "driver returned no verdicts",
    });
  });

  it("unreviewedPairs flags a requested role missing both verdict and recheck", () => {
    const claim = baseClaim("claim-x") as unknown as RecordedClaim["claim"];
    const reviewed: Verdict = {
      claimId: "claim-x",
      role: "contadores",
      resultado: "ok",
      severidad: "aviso",
      hallazgo: "",
      evidencia: [],
    };
    const recorded: RecordedClaim = { claim, hash: "h", verdicts: [reviewed] };

    expect(unreviewedPairs([recorded], ["contadores", "metodico"])).toEqual([
      { claim: "claim-x", role: "metodico" },
    ]);
    // A declared pause already accounts for the missing pairs.
    expect(
      unreviewedPairs([{ ...recorded, recheck: "interrumpido" }], [
        "contadores",
        "metodico",
      ]),
    ).toEqual([]);
  });

  it("empty roles list ⇒ code 3, no state written, driver never called", async () => {
    const session = newSession();
    const { driver, calls } = okDriver();

    const result = await runEval({ ...evalOpts(session, driver), roles: [] });

    expect(result.code).toBe(3);
    expect(calls).toHaveLength(0);
    expect(loadState(stateDir(session))).toBeNull();
  });
});

// ── state IO ──────────────────────────────────────────────────────────────

describe("writeFileAtomic", () => {
  it("replaces the existing file and leaves no .tmp behind", () => {
    const dir = newTempDir();
    const path = join(dir, "state.json");

    writeFileAtomic(path, "first\n");
    writeFileAtomic(path, "second\n");

    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

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

  it("--budget N plumbs to runEval and fails closed with a declared gap", async () => {
    const session = newSession();
    const limited = okDriver();

    const code = await quietly(() =>
      main(["eval", session.reportPath, "--budget", "5"], {
        driver: limited.driver,
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(1);
    expect(limited.calls).toHaveLength(5);
    const paused = loadState(stateDir(session));
    expect(paused).not.toBeNull();
    if (paused === null) throw new Error("state.json should exist after the pause");
    expect(gapPairs(paused, DEFAULT_ROLES)).toHaveLength(7);
  });

  it("without a flag, a missing config fails open to the default 20", async () => {
    const session = newSession(); // no .evaluador/config.json at all
    const { driver, calls } = okDriver();

    const code = await quietly(() =>
      main(["eval", session.reportPath], { driver, cwd: session.cwd }),
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(12); // 12 ≤ 20: the default allowed the whole run
  });

  it("a valid config budget is the default without a flag", async () => {
    const session = newSession();
    const dotDir = stateDir(session);
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, "config.json"), JSON.stringify({ budget: 2 }));

    const { driver, calls } = okDriver();
    const code = await quietly(() =>
      main(["eval", session.reportPath], { driver, cwd: session.cwd }),
    );

    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("a corrupt config fails open to the default 20", async () => {
    const session = newSession();
    const dotDir = stateDir(session);
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, "config.json"), "{no es json");

    const { driver, calls } = okDriver();
    const code = await quietly(() =>
      main(["eval", session.reportPath], { driver, cwd: session.cwd }),
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(12);
  });

  it("an invalid --budget value is a usage error (exit 3, no driver call)", async () => {
    const session = newSession();
    const { driver, calls } = okDriver();

    const code = await quietly(() =>
      main(["eval", session.reportPath, "--budget", "muchas"], {
        driver,
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it("--budget 0 pauses every pair with a declared gap and exit 1", async () => {
    const session = newSession();
    const { driver, calls } = okDriver();

    const code = await quietly(() =>
      main(["eval", session.reportPath, "--budget", "0"], {
        driver,
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    const paused = loadState(stateDir(session));
    expect(paused).not.toBeNull();
    if (paused === null) throw new Error("state.json should exist after the pause");
    expect(gapPairs(paused, DEFAULT_ROLES)).toHaveLength(12);
    for (const rc of paused.claims) {
      expect(rc.recheck).toBe("presupuesto-agotado");
      expect(rc.verdicts).toHaveLength(0);
    }
  });

  it("--roles plumbs a resolved subset into runEval", async () => {
    const session = newSession();
    const { driver, calls } = okDriver();

    const code = await quietly(() =>
      main(["eval", session.reportPath, "--roles", "contador,falsificador"], {
        driver,
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(6); // 3 claims × the 2 requested roles
    expect([...new Set(calls.map((call) => call.role))].sort()).toEqual([
      "contadores",
      "falsificador",
    ]);
    const state = loadState(stateDir(session));
    expect(state?.roles).toEqual(["contadores", "falsificador"]);
  });

  it("--model plumbs into every role call of the run", async () => {
    const session = newSession();
    const { driver, calls } = okDriver();
    const model = "opencode-go/deepseek-v4.1-flash";

    const code = await quietly(() =>
      main(["eval", session.reportPath, "--model", model], {
        driver,
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(12); // 3 claims × the 4 default roles
    for (const call of calls) expect(call.model).toBe(model);
  });

  it("--roles with an unknown name is exit 3 and never calls the driver", async () => {
    const session = newSession();
    const { driver, calls } = okDriver();

    const code = await quietly(() =>
      main(["eval", session.reportPath, "--roles", "noexiste"], {
        driver,
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(3);
    expect(calls).toHaveLength(0);
  });
});

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});
