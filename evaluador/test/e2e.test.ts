// End-to-end (Task 12): one full `runEval` over the generated fixture
// (`fixtures.reporte.md`) with an injected fake driver. No network, no
// `opencode` binary, no subprocess: the fake driver replaces opencodeDriver
// entirely and is programmed with GENERATED verdicts only.
//
// The fixture carries three gate-valid claims (VERIFICADO, HIPÓTESIS,
// PENDIENTE) and the default rubric has four roles, so a clean run spends
// exactly 3 × 4 = 12 petitions of the 20-petition budget. A second, fresh run
// programs one blocking verdict to assert exit 1 and its issue artifact.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadState, runEval } from "../src/adversarial.js";
import type {
  AgentCall,
  AgentResult,
  Driver,
  Verdict,
} from "../src/driver/types.js";
import { runGate } from "../src/gate.js";
import { OUTPUT_FILES } from "../src/report.js";
import { DEFAULT_ROLES } from "../src/rubric.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures.reporte.md");
const BUDGET = 20;

const fixtureMd = readFileSync(FIXTURE, "utf8");

// ── generated-fixture guards (Review Focus #5) ────────────────────────────

// The fixture must declare itself generated in its first lines, and must not
// carry a realistic Spanish NIF: the only declared values are `555XXXXXX`
// placeholders inside the fictitious 555 range.
function assertGeneratedFixture(): void {
  const head = fixtureMd.split("\n").slice(0, 5).join("\n");
  expect(head).toContain("DATOS GENERADOS");
  expect(fixtureMd).toContain("NIF 555XXXXXX");
  for (const pattern of [/\b\d{8}[A-Za-z]\b/, /\b[A-Z]\d{7}[A-Za-z]\b/]) {
    expect(fixtureMd).not.toMatch(pattern);
  }
}

// ── fake driver ───────────────────────────────────────────────────────────

// The claim id travels to the driver only inside `material` (the orchestration
// deliberately withholds it from the verdict). Parsing it back keeps the
// program explicit per claim/role instead of depending on call order.
function claimIdFrom(call: AgentCall): string {
  const start = call.material.indexOf("{");
  const parsed = JSON.parse(call.material.slice(start)) as { id?: unknown };
  expect(typeof parsed.id).toBe("string");
  return parsed.id as string;
}

function generatedVerdict(call: AgentCall): Verdict {
  return {
    claimId: "", // the driver never knows the id; runEval must assign it
    role: call.role,
    resultado: "ok",
    severidad: "aviso",
    hallazgo: "",
    evidencia: ["veredicto generado de prueba"],
  };
}

type Program = (claimId: string, role: string) => Partial<Verdict> | undefined;

function fakeDriver(program: Program = () => undefined): {
  driver: Driver;
  calls: AgentCall[];
} {
  const calls: AgentCall[] = [];
  const driver: Driver = async (call): Promise<AgentResult> => {
    calls.push(call);
    const override = program(claimIdFrom(call), call.role) ?? {};
    return {
      // One spawned call per pair: the budget must count exactly this.
      calls: 1,
      verdicts: [{ ...generatedVerdict(call), ...override }],
    };
  };
  return { driver, calls };
}

// ── tempdir sessions ──────────────────────────────────────────────────────

const tempRoots = new Set<string>();

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evaluador-e2e-"));
  tempRoots.add(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

interface Session {
  cwd: string;
  outDir: string;
}

function newSession(): Session {
  const cwd = newTempDir();
  return { cwd, outDir: join(cwd, "salida") };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function issueFiles(cwd: string): string[] {
  const dir = join(cwd, ".evaluador", "issues");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^i-\d+\.json$/.test(name)).sort();
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("e2e: full runEval over the generated fixture", () => {
  it("the fixture is explicitly generated and has no realistic NIF", () => {
    assertGeneratedFixture();
  });

  it("clean programmed verdicts => exit 0, 12 petitions, four parseable artifacts", async () => {
    const gate = runGate(fixtureMd);
    expect(gate.ok).toBe(true);
    expect(gate.claims).toHaveLength(3);

    const expectedPetitions = gate.claims.length * DEFAULT_ROLES.length;
    const session = newSession();
    const { driver, calls } = fakeDriver();
    const result = await runEval({
      reportPath: FIXTURE,
      outDir: session.outDir,
      budget: BUDGET,
      driver,
      cwd: session.cwd,
    });

    // Only the injected fake ran: no real driver, therefore no network.
    expect(calls).toHaveLength(expectedPetitions);
    expect(result.code).toBe(0);
    expect(result.state.petitions).toBe(expectedPetitions);
    expect(result.state.petitions).toBeLessThanOrEqual(BUDGET);
    expect(result.spentThisRun).toBe(expectedPetitions);
    expect(result.cacheHits).toBe(0);
    expect(result.cacheMisses).toBe(expectedPetitions);

    // The same counter is what a resumed run reads back from state.
    expect(loadState(join(session.cwd, ".evaluador"))?.petitions).toBe(
      expectedPetitions,
    );

    // The four Task 11 artifacts land in outDir and parse.
    for (const name of Object.values(OUTPUT_FILES)) {
      expect(existsSync(join(session.outDir, name))).toBe(true);
    }
    const md = readFileSync(join(session.outDir, OUTPUT_FILES.md), "utf8");
    const html = readFileSync(join(session.outDir, OUTPUT_FILES.html), "utf8");
    const evidencia = readJson(join(session.outDir, OUTPUT_FILES.evidencia)) as {
      claims: Array<{ id: string; verdicts: Verdict[] }>;
    };
    const resumen = readJson(join(session.outDir, OUTPUT_FILES.resumen)) as {
      claims: number;
      blockers: number;
      warnings: number;
      openIssues: number;
      petitions: number;
      budget: number | null;
      estado: string;
    };

    expect(md).toContain("# Reporte final — evaluador");
    expect(html).toContain("<!doctype html>");
    expect(evidencia.claims.map((claim) => claim.id)).toEqual(
      gate.claims.map((claim) => claim.id),
    );
    // Every verdict was assigned to its claim and role by the orchestrator.
    for (const claim of evidencia.claims) {
      expect(claim.verdicts).toHaveLength(DEFAULT_ROLES.length);
      for (const verdict of claim.verdicts) {
        expect(verdict.claimId).toBe(claim.id);
        expect(DEFAULT_ROLES).toContain(verdict.role);
      }
    }
    expect(resumen).toMatchObject({
      claims: 3,
      blockers: 0,
      warnings: 0,
      openIssues: 0,
      petitions: expectedPetitions,
      budget: BUDGET,
      estado: "cerrado",
    });
    // No blocking verdict => no issue artifacts at all.
    expect(issueFiles(session.cwd)).toEqual([]);
  });

  it("one programmed bloqueante => exit 1 and exactly one issue file", async () => {
    const session = newSession();
    const { driver } = fakeDriver((claimId, role) =>
      claimId === "claim-ficticio-002" && role === "contadores"
        ? {
            resultado: "problema",
            severidad: "bloqueante",
            hallazgo: "hallazgo generado de prueba: filas traídas sin justificar",
            evidencia: ["dato generado de prueba"],
          }
        : undefined,
    );
    const result = await runEval({
      reportPath: FIXTURE,
      outDir: session.outDir,
      budget: BUDGET,
      driver,
      cwd: session.cwd,
    });

    expect(result.code).toBe(1);
    expect(result.state.petitions).toBe(
      runGate(fixtureMd).claims.length * DEFAULT_ROLES.length,
    );

    const files = issueFiles(session.cwd);
    expect(files).toEqual(["i-001.json"]);
    const issue = readJson(join(session.cwd, ".evaluador", "issues", files[0]!)) as {
      claimId: string;
      role: string;
      severity: string;
      estado: string;
      hallazgo: string;
    };
    expect(issue).toMatchObject({
      claimId: "claim-ficticio-002",
      role: "contadores",
      severity: "bloqueante",
      estado: "abierta",
      hallazgo: "hallazgo generado de prueba: filas traídas sin justificar",
    });

    // The four artifacts still exist and report the open closure.
    for (const name of Object.values(OUTPUT_FILES)) {
      expect(existsSync(join(session.outDir, name))).toBe(true);
    }
    const resumen = readJson(join(session.outDir, OUTPUT_FILES.resumen)) as {
      blockers: number;
      openIssues: number;
      estado: string;
    };
    expect(resumen).toMatchObject({
      blockers: 1,
      openIssues: 1,
      estado: "abierto",
    });
  });
});
