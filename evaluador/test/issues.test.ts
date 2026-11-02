// Tests for Task 10: issue artifacts (`.evaluador/issues/<id>.json`) and the
// optional `--git-branches` flag. Every fixture is GENERATED (fictitious) and
// every driver is an injected fake: no network, no real agent. Git commands run
// ONLY inside throwaway repos created with `git init` under the OS tempdir —
// never in the project repository.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runEval } from "../src/adversarial.js";
import type { EvaluatorState, RecordedClaim } from "../src/adversarial.js";
import { main } from "../src/cli.js";
import type { Claim } from "../src/contract.js";
import type { AgentCall, Driver, Verdict } from "../src/driver/types.js";
import { writeIssues } from "../src/issues.js";
import type { Issue } from "../src/issues.js";
import { DEFAULT_ROLES, RUBRIC_VERSION } from "../src/rubric.js";
import type { RoleId } from "../src/rubric.js";

// ── generated fixtures ────────────────────────────────────────────────────

function baseClaim(id: string): Claim {
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

function reportMd(claims: Claim[]): string {
  const blocks = claims.map(
    (claim) => "```json\n" + JSON.stringify(claim, null, 2) + "\n```",
  );
  return ["# Reporte de prueba (datos generados)", ...blocks].join("\n\n") + "\n";
}

function verdict(
  claimId: string,
  role: string,
  overrides: Partial<Verdict> = {},
): Verdict {
  return {
    claimId,
    role,
    resultado: "ok",
    severidad: "aviso",
    hallazgo: "",
    evidencia: [],
    ...overrides,
  };
}

function recorded(
  claim: Claim,
  verdicts: Verdict[],
  recheck?: RecordedClaim["recheck"],
): RecordedClaim {
  return {
    claim,
    hash: `hash-${claim.id}`,
    verdicts,
    ...(recheck === undefined ? {} : { recheck }),
  };
}

function stateFor(
  claims: RecordedClaim[],
  roles?: RoleId[],
): EvaluatorState {
  return {
    version: 1,
    reporte: "hash-ficticio",
    rubricVersion: RUBRIC_VERSION,
    claims,
    petitions: 0,
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...(roles === undefined ? {} : { roles }),
  };
}

// ── tempdir sessions ──────────────────────────────────────────────────────

const tempRoots = new Set<string>();

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evaluador-issues-test-"));
  tempRoots.add(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.clear();
});

function stateDir(cwd: string): string {
  return join(cwd, ".evaluador");
}

function issueFiles(dir: string): string[] {
  const issuesDir = join(dir, "issues");
  if (!existsSync(issuesDir)) return [];
  return readdirSync(issuesDir).filter((name) => name.endsWith(".json")).sort();
}

function readIssue(dir: string, id: string): Issue {
  return JSON.parse(readFileSync(join(dir, "issues", `${id}.json`), "utf8")) as Issue;
}

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  return fn().finally(() => {
    console.log = log;
    console.error = error;
  });
}

// Runs `fn` while capturing stdout/stderr lines (used to assert the git warning
// without leaking output into the suite).
async function captureAll<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; logs: string[]; errors: string[] }> {
  const log = console.log;
  const error = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), logs, errors };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ── writeIssues ───────────────────────────────────────────────────────────

describe("writeIssues", () => {
  it("(a) a bloqueante verdict writes i-001.json with severity bloqueante", () => {
    const dir = stateDir(newTempDir());
    const claim = baseClaim("c1");
    const blocking = verdict("c1", "contadores", {
      resultado: "problema",
      severidad: "bloqueante",
      hallazgo: "criterio del total ausente",
      evidencia: ["traza ficticia"],
    });
    const state = stateFor([recorded(claim, [blocking])]);

    const issues = writeIssues(dir, [blocking], state);

    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue?.id).toBe("i-001");
    const path = join(dir, "issues", "i-001.json");
    expect(existsSync(path)).toBe(true);
    const stored = readIssue(dir, "i-001");
    expect(stored).toEqual(issue);
    expect(stored.severity).toBe("bloqueante");
    expect(stored.estado).toBe("abierta");
    expect(stored.claimId).toBe("c1");
    expect(stored.role).toBe("contadores");
    expect(stored.hallazgo).toBe("criterio del total ausente");
    // rubricItem names the failing rule in one line; propuesta is derived from
    // the hallazgo, also one line.
    expect(stored.rubricItem.trim().length).toBeGreaterThan(0);
    expect(stored.rubricItem).not.toContain("\n");
    expect(stored.propuesta.trim().length).toBeGreaterThan(0);
    expect(stored.propuesta).not.toContain("\n");
  });

  it("(b) two problems get sequential ids in state order", () => {
    const dir = stateDir(newTempDir());
    const c1 = baseClaim("c1");
    const c2 = baseClaim("c2");
    const v1 = verdict("c1", "falsificador", {
      resultado: "problema",
      severidad: "bloqueante",
      hallazgo: "fallo ficticio uno",
    });
    const v2 = verdict("c2", "metodico", {
      resultado: "problema",
      severidad: "aviso",
      hallazgo: "fallo ficticio dos",
    });
    const state = stateFor([recorded(c1, [v1]), recorded(c2, [v2])]);

    // Deliberately reversed input: ids follow state claim order, not the flat
    // array order, so re-runs with the same state are stable.
    const issues = writeIssues(dir, [v2, v1], state);

    expect(issues.map((issue) => issue.id)).toEqual(["i-001", "i-002"]);
    expect(issues.map((issue) => issue.claimId)).toEqual(["c1", "c2"]);
    expect(issues.map((issue) => issue.severity)).toEqual([
      "bloqueante",
      "aviso",
    ]);
    expect(issueFiles(dir)).toEqual(["i-001.json", "i-002.json"]);
  });

  it("(c) an ok verdict produces NO issue", () => {
    const dir = stateDir(newTempDir());
    const claim = baseClaim("c1");
    const ok = verdict("c1", "contadores");
    const state = stateFor([recorded(claim, [ok])]);

    const issues = writeIssues(dir, [ok], state);

    expect(issues).toEqual([]);
    expect(issueFiles(dir)).toEqual([]);
  });

  it("prunes a stale issue after the problem is fixed", () => {
    const dir = stateDir(newTempDir());
    const claim = baseClaim("c1");
    const blocking = verdict("c1", "contadores", {
      resultado: "problema",
      severidad: "bloqueante",
      hallazgo: "fallo ficticio",
    });
    writeIssues(dir, [blocking], stateFor([recorded(claim, [blocking])]));
    expect(issueFiles(dir)).toEqual(["i-001.json"]);

    const ok = verdict("c1", "contadores");
    writeIssues(dir, [ok], stateFor([recorded(claim, [ok])]));

    expect(issueFiles(dir)).toEqual([]);
  });

  it("derives one sin-re-verificar issue per absent role after a budget pause", () => {
    const dir = stateDir(newTempDir());
    const claim = baseClaim("c1");
    const reviewed = verdict("c1", "contadores");
    const state = stateFor(
      [recorded(claim, [reviewed], "presupuesto-agotado")],
      DEFAULT_ROLES,
    );

    const issues = writeIssues(dir, [reviewed], state);

    expect(issues.map((issue) => [issue.claimId, issue.role, issue.estado])).toEqual([
      ["c1", "segunda-fuente", "sin-re-verificar"],
      ["c1", "falsificador", "sin-re-verificar"],
      ["c1", "metodico", "sin-re-verificar"],
    ]);
    expect(issues.map((issue) => issue.id)).toEqual(["i-001", "i-002", "i-003"]);
    for (const issue of issues) {
      expect(issue.severity).toBe("bloqueante");
      expect(issue.hallazgo).toBe("no re-verificado: presupuesto agotado");
      expect(issue.propuesta).not.toContain("\n");
    }
    expect(issueFiles(dir)).toEqual([
      "i-001.json",
      "i-002.json",
      "i-003.json",
    ]);
  });

  it("maps the interrumpido marker to a sin-re-verificar issue with its own wording", () => {
    const dir = stateDir(newTempDir());
    const claim = baseClaim("c1");
    const reviewed = verdict("c1", "contadores");
    const state = stateFor(
      [recorded(claim, [reviewed], "interrumpido")],
      DEFAULT_ROLES,
    );

    const issues = writeIssues(dir, [reviewed], state);

    expect(issues.map((issue) => issue.role)).toEqual([
      "segunda-fuente",
      "falsificador",
      "metodico",
    ]);
    for (const issue of issues) {
      expect(issue.severity).toBe("bloqueante");
      expect(issue.estado).toBe("sin-re-verificar");
      expect(issue.hallazgo).toBe("no re-verificado: ejecución interrumpida");
    }
  });

  it("a paused claim with zero verdicts still yields one issue per role", () => {
    const dir = stateDir(newTempDir());
    const claim = baseClaim("c1");
    const state = stateFor(
      [recorded(claim, [], "presupuesto-agotado")],
      DEFAULT_ROLES,
    );

    const issues = writeIssues(dir, [], state);

    expect(issues.map((issue) => issue.role)).toEqual([...DEFAULT_ROLES]);
    expect(issues.every((issue) => issue.estado === "sin-re-verificar")).toBe(
      true,
    );
  });

  it("sin-re-verificar verdicts become issues with the verdict's hallazgo", () => {
    const dir = stateDir(newTempDir());
    const claim = baseClaim("c1");
    // The failure lands on the last role; verdict-derived issues must still
    // come first, before the gap-derived ones.
    const failed = verdict("c1", "metodico", {
      resultado: "sin-re-verificar",
      severidad: "bloqueante",
      hallazgo: "driver timeout (without response in 300 s)",
    });
    const state = stateFor(
      [recorded(claim, [failed], "sin-re-verificar")],
      DEFAULT_ROLES,
    );

    const issues = writeIssues(dir, [failed], state);

    expect(issues).toHaveLength(4);
    expect(issues[0]).toMatchObject({
      id: "i-001",
      claimId: "c1",
      role: "metodico",
      severity: "bloqueante",
      hallazgo: "driver timeout (without response in 300 s)",
      estado: "sin-re-verificar",
    });
    expect(issues.slice(1).map((issue) => issue.role)).toEqual([
      "contadores",
      "segunda-fuente",
      "falsificador",
    ]);
    for (const issue of issues.slice(1)) {
      expect(issue.estado).toBe("sin-re-verificar");
      expect(issue.hallazgo).toBe("no re-verificado: reintento pendiente");
    }
  });

  it("re-runs with unchanged content reuse the same ids and bytes", () => {
    const dir = stateDir(newTempDir());
    const claim = baseClaim("c1");
    const blocking = verdict("c1", "contadores", {
      resultado: "problema",
      severidad: "bloqueante",
      hallazgo: "fallo ficticio estable",
    });
    const state = stateFor([recorded(claim, [blocking])]);

    const first = writeIssues(dir, [blocking], state);
    const firstBytes = readFileSync(join(dir, "issues", "i-001.json"), "utf8");
    const second = writeIssues(dir, [blocking], state);
    const secondBytes = readFileSync(join(dir, "issues", "i-001.json"), "utf8");

    expect(second).toEqual(first);
    expect(secondBytes).toBe(firstBytes);
    expect(issueFiles(dir)).toEqual(["i-001.json"]);
  });
});

// ── runEval integration ───────────────────────────────────────────────────

function newSession(claims: Claim[]): { cwd: string; reportPath: string } {
  const cwd = newTempDir();
  const reportPath = join(cwd, "reporte.md");
  writeFileSync(reportPath, reportMd(claims));
  return { cwd, reportPath };
}

describe("runEval emits issue artifacts", () => {
  it("writes issues for problem verdicts and keeps exit 1", async () => {
    const session = newSession([baseClaim("c1")]);
    const driver: Driver = async (call) =>
      call.role === "falsificador"
        ? {
            verdicts: [
              verdict("", call.role, {
                resultado: "problema",
                severidad: "bloqueante",
                hallazgo: "fallo ficticio bloqueante",
              }),
            ],
            calls: 1,
          }
        : {
            verdicts: [verdict("", call.role)],
            calls: 1,
          };

    const result = await runEval({
      reportPath: session.reportPath,
      cwd: session.cwd,
      budget: 20,
      driver,
    });

    expect(result.code).toBe(1);
    const files = issueFiles(stateDir(session.cwd));
    expect(files).toEqual(["i-001.json"]);
    const issue = readIssue(stateDir(session.cwd), "i-001");
    expect(issue).toMatchObject({
      claimId: "c1",
      role: "falsificador",
      severity: "bloqueante",
      estado: "abierta",
      hallazgo: "fallo ficticio bloqueante",
    });
  });

  it("writes no issues when every verdict is ok", async () => {
    const session = newSession([baseClaim("c1")]);
    const driver: Driver = async (call) => ({
      verdicts: [verdict("", call.role)],
      calls: 1,
    });

    const result = await runEval({
      reportPath: session.reportPath,
      cwd: session.cwd,
      budget: 20,
      driver,
    });

    expect(result.code).toBe(0);
    expect(issueFiles(stateDir(session.cwd))).toEqual([]);
  });

  it("a budget pause writes sin-re-verificar issues for the unbuilt pairs", async () => {
    const session = newSession([baseClaim("c1")]);
    const driver: Driver = async (call) => ({
      verdicts: [verdict("", call.role)],
      calls: 1,
    });

    const result = await runEval({
      reportPath: session.reportPath,
      cwd: session.cwd,
      budget: 1,
      driver,
    });

    expect(result.code).toBe(1);
    const issues = issueFiles(stateDir(session.cwd)).map((file) =>
      readIssue(stateDir(session.cwd), file.replace(/\.json$/, "")),
    );
    expect(issues.map((issue) => issue.role)).toEqual([
      "segunda-fuente",
      "falsificador",
      "metodico",
    ]);
    for (const issue of issues) {
      expect(issue.estado).toBe("sin-re-verificar");
      expect(issue.hallazgo).toBe("no re-verificado: presupuesto agotado");
    }
  });
});

// ── --git-branches ────────────────────────────────────────────────────────

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function initGitRepo(cwd: string): void {
  const init = git(cwd, ["init", "-q"]);
  expect(init.status).toBe(0);
}

function branches(cwd: string): string[] {
  // A fresh `git init` repo has an unborn HEAD: `git branch` lists nothing
  // until the first commit, so also read the branch HEAD symbolically points at.
  const head = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const refs = git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  expect(refs.status).toBe(0);
  const names = [...refs.stdout.split("\n")];
  if (head.status === 0) names.push(head.stdout);
  return [...new Set(names.map((line) => line.trim()).filter((line) => line !== ""))].sort();
}

function blockingDriver(claimId: string): Driver {
  return async (call: AgentCall) => ({
    verdicts:
      call.material.includes(`"id": "${claimId}"`)
        ? [
            verdict("", call.role, {
              resultado: "problema",
              severidad: "bloqueante",
              hallazgo: "fallo ficticio bloqueante",
            }),
          ]
        : [verdict("", call.role)],
    calls: 1,
  });
}

describe("--git-branches", () => {
  it("(d) creates problema/<claimId> in a temporary git repo", async () => {
    const session = newSession([baseClaim("c1")]);
    initGitRepo(session.cwd);

    const code = await quietly(() =>
      main(["eval", session.reportPath, "--git-branches"], {
        driver: blockingDriver("c1"),
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(1);
    expect(branches(session.cwd)).toContain("problema/c1");
    expect(branches(session.cwd)).not.toContain("problema/c2");
  });

  it("is off by default: no branch without the flag", async () => {
    const session = newSession([baseClaim("c1")]);
    initGitRepo(session.cwd);

    const code = await quietly(() =>
      main(["eval", session.reportPath], {
        driver: blockingDriver("c1"),
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(1);
    expect(branches(session.cwd)).not.toContain("problema/c1");
  });

  it("never branches for an aviso-only problem", async () => {
    const session = newSession([baseClaim("c1")]);
    initGitRepo(session.cwd);
    const driver: Driver = async (call) => ({
      verdicts: [
        verdict("", call.role, {
          resultado: "problema",
          severidad: "aviso",
          hallazgo: "aviso ficticio",
        }),
      ],
      calls: 1,
    });

    const code = await quietly(() =>
      main(["eval", session.reportPath, "--git-branches"], {
        driver,
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(0);
    expect(branches(session.cwd).filter((name) => name.startsWith("problema/"))).toEqual([]);
  });

  it("a git failure only warns and never changes the exit code", async () => {
    const session = newSession([baseClaim("c1")]); // NOT a git repository
    const { value: code, errors } = await captureAll(() =>
      main(["eval", session.reportPath, "--git-branches"], {
        driver: blockingDriver("c1"),
        cwd: session.cwd,
      }),
    );

    expect(code).toBe(1); // still the review's exit code
    expect(errors.join("\n")).toMatch(/warning/i);
    expect(errors.join("\n")).toContain("problema/c1");
  });
});
