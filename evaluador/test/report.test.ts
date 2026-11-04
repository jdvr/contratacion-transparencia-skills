// Tests for Task 11: final outputs (`reporte-final.md`, `reporte-final.html`,
// `evidencia.json`, `resumen.json`). The state and issues are PROGRAMMED
// fixtures (1 bloqueante, 1 aviso, 3 claims) and every driver is an injected
// fake — no network, no real agent, and every tempdir is removed in `afterAll`.
// All claim data is generated (fictitious) and labelled as such.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runEval } from "../src/adversarial.js";
import type { EvaluatorState, RecordedClaim } from "../src/adversarial.js";
import { main } from "../src/cli.js";
import type { Claim } from "../src/contract.js";
import type { AgentCall, Driver, Verdict } from "../src/driver/types.js";
import type { Issue } from "../src/issues.js";
import {
  OUTPUT_FILES,
  renderEvidenciaJson,
  renderFinalMd,
  renderHtml,
  renderResumen,
  writeOutputs,
} from "../src/report.js";
import { DEFAULT_ROLES, RUBRIC_VERSION } from "../src/rubric.js";

// ── generated fixtures ────────────────────────────────────────────────────

// The URL deliberately carries a query string: every output must preserve it
// verbatim (machine consumer) or escape it, never truncate it.
const CLAIM_URL = "https://datos.canarias.es/ejemplo-generado?resource_id=abc&limit=10";

function baseClaim(id: string, overrides: Partial<Claim> = {}): Claim {
  return {
    id,
    afirmacion: `afirmación ficticia ${id} (dato generado)`,
    cifra: "1.000,00 €",
    fuente: "Fuente Generada de Prueba",
    url: CLAIM_URL,
    fecha_dato: "2025",
    fecha_consulta: "2026-11-01",
    criterio: "criterio ficticio del total para la prueba",
    filas_traidas: 5,
    conteo_declarado: 10,
    banderas: ["dato generado; solo para pruebas"],
    dedup: false,
    etiqueta: "VERIFICADO",
    licencia: "Fuente: Gobierno de Canarias (reutilización con atribución)",
    ...overrides,
  };
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

function issue(overrides: Partial<Issue> & Pick<Issue, "id" | "claimId" | "role" | "severity">): Issue {
  return {
    rubricItem: "regla ficticia de la rubric",
    hallazgo: "hallazgo ficticio (dato generado)",
    propuesta: "Corregir y re-verificar: hallazgo ficticio (dato generado)",
    estado: "abierta",
    ...overrides,
  };
}

// Three claims, one issue per non-ok verdict: c1 blocks, c2 warns, c3 is clean.
function programmedState(): EvaluatorState {
  const c1 = recorded(baseClaim("claim-c1"), [
    verdict("claim-c1", "contadores", {
      resultado: "problema",
      severidad: "bloqueante",
      hallazgo: "la cifra mezcla adjudicado y estimado (dato generado)",
      evidencia: [`evidencia generada: ${CLAIM_URL}`],
    }),
    verdict("claim-c1", "segunda-fuente"),
    verdict("claim-c1", "falsificador"),
    verdict("claim-c1", "metodico"),
  ]);
  const c2 = recorded(
    baseClaim("claim-c2", {
      etiqueta: "HIPÓTESIS",
      licencia: "Datos Generados (fixture de prueba; sin atribución institucional)",
    }),
    [
      verdict("claim-c2", "contadores"),
      verdict("claim-c2", "segunda-fuente", {
        resultado: "problema",
        severidad: "aviso",
        hallazgo: "falta el contraste por una vía lógicamente distinta (dato generado)",
      }),
      verdict("claim-c2", "falsificador"),
      verdict("claim-c2", "metodico"),
    ],
  );
  const c3 = recorded(
    baseClaim("claim-c3", { licencia: undefined }),
    [
      verdict("claim-c3", "contadores"),
      verdict("claim-c3", "segunda-fuente"),
      verdict("claim-c3", "falsificador"),
      verdict("claim-c3", "metodico"),
    ],
  );
  return {
    version: 1,
    reporte: "hash-ficticio-del-reporte",
    rubricVersion: RUBRIC_VERSION,
    claims: [c1, c2, c3],
    petitions: 7,
    updatedAt: "2026-11-02T10:00:00.000Z",
    roles: [...DEFAULT_ROLES],
  };
}

function programmedIssues(): Issue[] {
  return [
    issue({
      id: "i-001",
      claimId: "claim-c1",
      role: "contadores",
      severity: "bloqueante",
      rubricItem: "una suma, un criterio",
      hallazgo: "la cifra mezcla adjudicado y estimado (dato generado)",
    }),
    issue({
      id: "i-002",
      claimId: "claim-c2",
      role: "segunda-fuente",
      severity: "aviso",
      rubricItem: "contraste por una vía lógicamente distinta",
      hallazgo: "falta el contraste por una vía lógicamente distinta (dato generado)",
    }),
  ];
}

const RUN_STATS = {
  budget: 20,
  spentThisRun: 5,
  cacheHits: 1,
  cacheMisses: 2,
};

function stateFor(claims: RecordedClaim[]): EvaluatorState {
  return {
    version: 1,
    reporte: "hash-ficticio",
    rubricVersion: RUBRIC_VERSION,
    claims,
    petitions: 0,
    updatedAt: "2026-11-02T10:00:00.000Z",
    roles: [...DEFAULT_ROLES],
  };
}

// ── tempdir sessions ──────────────────────────────────────────────────────

const tempRoots = new Set<string>();

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evaluador-report-test-"));
  tempRoots.add(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.clear();
});

// ── (a) markdown ──────────────────────────────────────────────────────────

describe("renderFinalMd", () => {
  it("(a) carries the counters, each honest label, the attribution chip and the issues", () => {
    const md = renderFinalMd(programmedState(), programmedIssues());

    expect(md).toContain("# Reporte final — evaluador");
    expect(md).toContain("bloqueantes: 1");
    expect(md).toContain("avisos: 1");
    expect(md).toContain("claims: 3");
    expect(md).toContain("issues abiertos: 2");
    expect(md).toContain("sin re-verificar: 0");

    // Honest labels in the repo's style: bracket marks and the provenance mark.
    expect(md).toContain("[VERIFICADO]");
    expect(md).toContain("[HIPÓTESIS]");
    expect(md).toContain("**Verificado:**");

    // Attribution chip only where the claim's licencia asks for it.
    expect(md).toContain("Fuente: Gobierno de Canarias");

    // A clean claim must not inherit phantom warnings from `ok` verdicts;
    // only non-ok findings count as bloqueante/aviso.
    expect(md).toContain("4 (1 bloqueante(s), 0 aviso(s))");
    expect(md).toContain("4 (0 bloqueante(s), 1 aviso(s))");

    // Claims table + detail, issue list and sources summary.
    expect(md).toContain("claim-c1");
    expect(md).toContain("claim-c2");
    expect(md).toContain("1.000,00 €");
    expect(md).toContain("i-001");
    expect(md).toContain("i-002");
    expect(md).toContain("la cifra mezcla adjudicado y estimado (dato generado)");
    expect(md).toContain("## Fuentes");
    expect(md).toContain(CLAIM_URL);
    expect(md).toContain("peticiones acumuladas: 7");
  });

  it("(a2) renders run-scoped spend, cache use and the cumulative total", () => {
    const md = renderFinalMd(programmedState(), programmedIssues(), RUN_STATS);

    expect(md).toContain("## Uso de esta ejecución");
    expect(md).toContain("peticiones acumuladas: 7");
    expect(md).toContain("esta ejecución: 5 de budget 20");
    expect(md).toContain("cache: 1 hit(s) / 2 miss(es)");
    // Honest limitation: the budget counts reviewer calls, not portal requests.
    expect(md).toContain("no peticiones a portales");
  });

  it("(a3) without run stats the spend line says honestly that it was not measured", () => {
    const md = renderFinalMd(programmedState(), programmedIssues());

    expect(md).toContain("esta ejecución: no medida");
    expect(md).toContain("cache: no medido");
  });

  it("attribution chip is absent when no licencia mentions Canarias", () => {
    const state = stateFor([
      recorded(
        baseClaim("claim-x", { licencia: "Datos Generados (fixture de prueba)" }),
        [],
      ),
    ]);

    expect(renderFinalMd(state, [])).not.toContain("Fuente: Gobierno de Canarias");
    expect(renderHtml(state, [])).not.toContain("Fuente: Gobierno de Canarias");
  });

  it("attribution chip matches Canarias case-insensitively", () => {
    for (const licencia of [
      "fuente: gobierno de canarias",
      "gobcan-aviso-legal",
      "istac-aviso-legal",
    ]) {
      const state = stateFor([
        recorded(baseClaim("claim-x", { licencia }), []),
      ]);
      expect(renderFinalMd(state, [])).toContain("Fuente: Gobierno de Canarias");
    }
  });

  it("does not attach the Canarias chip to another public body's licence", () => {
    const state = stateFor([
      recorded(
        baseClaim("claim-x", { licencia: "Gobierno de España (licencia estatal)" }),
        [],
      ),
    ]);

    expect(renderFinalMd(state, [])).not.toContain("Fuente: Gobierno de Canarias");
  });

  it("says explicitly when there are no issues and no claims", () => {
    const md = renderFinalMd(stateFor([]), []);

    expect(md).toContain("bloqueantes: 0");
    expect(md).toContain("Sin problemas");
    expect(md).toContain("Sin afirmaciones");
  });

  it("never upgrades an honest label into a closed claim", () => {
    const state = programmedState();
    const md = renderFinalMd(state, programmedIssues());

    // c1 is VERIFICADO but has a blocking verdict: it must NOT read as verified.
    expect(md).toContain("**No verificado:**");
    // c2 is HIPÓTESIS: the honest label is kept, never reworded as verified.
    expect(md).toContain("Etiqueta honesta");
  });
});

// ── (b) HTML ──────────────────────────────────────────────────────────────

describe("renderHtml", () => {
  it("(b) is a self-contained HTML document with a claims table and counters", () => {
    const html = renderHtml(programmedState(), programmedIssues());

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("bloqueantes");
    expect(html).toContain("claim-c1");
    expect(html).toContain("[VERIFICADO]");
    expect(html).toContain("Fuente: Gobierno de Canarias");
    expect(html).toContain(CLAIM_URL.replace(/&/g, "&amp;")); // escaped, not dropped
  });

  it("(b2) shows the run-scoped spend line and the budget limitation", () => {
    const html = renderHtml(programmedState(), programmedIssues(), RUN_STATS);

    expect(html).toContain("Uso de esta ejecución");
    expect(html).toContain("peticiones acumuladas:</strong> 7");
    expect(html).toContain("esta ejecución:</strong> 5 de budget 20");
    expect(html).toContain("cache:</strong> 1 hit(s) / 2 miss(es)");
    expect(html).toContain("no peticiones a portales");
  });

  it("imports no library of any kind (inline CSS only)", () => {
    const html = renderHtml(programmedState(), programmedIssues());

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).not.toContain("require(");
    expect(html).not.toContain("cdn.");
    expect(html).toContain("<style>");
  });

  it("escapes claim content instead of injecting it as markup", () => {
    const state = stateFor([
      recorded(
        baseClaim("claim-x", {
          afirmacion: 'dato <script>alert("x")</script> & más',
        }),
        [],
      ),
    ]);
    const html = renderHtml(state, []);

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&amp; más");
  });

  it("never emits a non-http(s) url as a clickable link", () => {
    const state = stateFor([
      recorded(baseClaim("claim-x", { url: "javascript:alert(1)" }), []),
    ]);
    const html = renderHtml(state, []);

    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("<code>javascript:alert(1)</code>");
  });

  it("carries the v2 source-graph TODO only in the code, not as a fake graph", () => {
    const html = renderHtml(programmedState(), programmedIssues());

    expect(html).not.toContain("TODO(v2)");
    expect(html).not.toMatch(/<svg/i);
  });
});

// ── (c) evidence JSON ─────────────────────────────────────────────────────

describe("renderEvidenciaJson", () => {
  it("(c) parses back to the 3 claims with their exact fields and intact urls", () => {
    const data = JSON.parse(renderEvidenciaJson(programmedState())) as {
      version: number;
      reporte: string;
      rubricVersion: string;
      claims: Array<Record<string, unknown>>;
    };

    expect(data.version).toBe(1);
    expect(data.reporte).toBe("hash-ficticio-del-reporte");
    expect(data.rubricVersion).toBe(RUBRIC_VERSION);
    expect(data.claims).toHaveLength(3);
    expect(data.claims.map((claim) => claim.id)).toEqual([
      "claim-c1",
      "claim-c2",
      "claim-c3",
    ]);
    for (const claim of data.claims) {
      expect(claim.url).toBe(CLAIM_URL);
      expect(claim.afirmacion).toEqual(expect.any(String));
      expect(claim.fuente).toBe("Fuente Generada de Prueba");
      expect(claim.criterio).toBe("criterio ficticio del total para la prueba");
      expect(claim.fecha_dato).toBe("2025");
      expect(claim.fecha_consulta).toBe("2026-11-01");
      expect(claim.dedup).toBe(false);
      expect(claim.banderas).toEqual(["dato generado; solo para pruebas"]);
      expect(Array.isArray(claim.verdicts)).toBe(true);
    }
    expect(data.claims[0]?.licencia).toBe(
      "Fuente: Gobierno de Canarias (reutilización con atribución)",
    );
    expect(data.claims[2]?.licencia).toBeUndefined();
  });

  it("keeps every verdict and its evidence verbatim", () => {
    const data = JSON.parse(renderEvidenciaJson(programmedState())) as {
      claims: Array<{ verdicts: Verdict[] }>;
    };
    const [c1, c2, c3] = data.claims;

    expect(c1?.verdicts).toHaveLength(4);
    expect(c1?.verdicts[0]).toEqual({
      claimId: "claim-c1",
      role: "contadores",
      resultado: "problema",
      severidad: "bloqueante",
      hallazgo: "la cifra mezcla adjudicado y estimado (dato generado)",
      evidencia: [`evidencia generada: ${CLAIM_URL}`],
    });
    expect(c2?.verdicts[1]?.resultado).toBe("problema");
    expect(c3?.verdicts.every((verdict) => verdict.resultado === "ok")).toBe(true);
  });

  it("carries the recheck marker and hash without inventing fields", () => {
    const state = stateFor([
      recorded(baseClaim("claim-c1"), [], "presupuesto-agotado"),
    ]);
    const data = JSON.parse(renderEvidenciaJson(state)) as {
      claims: Array<{ hash: string; recheck?: string }>;
    };

    expect(data.claims[0]?.hash).toBe("hash-claim-c1");
    expect(data.claims[0]?.recheck).toBe("presupuesto-agotado");
  });
});

// ── (d) summary JSON ──────────────────────────────────────────────────────

describe("renderResumen", () => {
  it("(d) exposes the documented English keys and the three responsible-use rules", () => {
    const data = JSON.parse(
      renderResumen(programmedState(), programmedIssues(), RUN_STATS),
    ) as Record<string, unknown>;

    expect(Object.keys(data).sort()).toEqual(
      [
        "claims",
        "blockers",
        "warnings",
        "openIssues",
        "unverifiedIssues",
        "petitions",
        "spentThisRun",
        "budget",
        "cacheHits",
        "cacheMisses",
        "estado",
        "usoResponsible",
      ].sort(),
    );

    expect(data.claims).toBe(3);
    expect(data.blockers).toBe(1);
    expect(data.warnings).toBe(1);
    expect(data.openIssues).toBe(2);
    expect(data.unverifiedIssues).toBe(0);
    expect(data.petitions).toBe(7); // state.petitions is cumulative
    expect(data.spentThisRun).toBe(5); // run-scoped, never mixed with petitions
    expect(data.budget).toBe(20);
    expect(data.cacheHits).toBe(1);
    expect(data.cacheMisses).toBe(2);
    expect(data.estado).toBe("abierto");

    const uso = JSON.stringify(data.usoResponsible);
    expect(uso).toContain("presupuesto de peticiones declarado");
    expect(uso).toContain("robots.txt y límites");
    expect(uso).toContain("cachea localmente");
  });

  it("reports unknown run stats honestly as null", () => {
    const data = JSON.parse(
      renderResumen(programmedState(), programmedIssues()),
    ) as Record<string, unknown>;

    expect(data.budget).toBeNull();
    expect(data.cacheHits).toBeNull();
    expect(data.cacheMisses).toBeNull();
    expect(data.spentThisRun).toBeNull();
  });

  it("computes the closure state from the issues", () => {
    const closed = JSON.parse(
      renderResumen(programmedState(), [], RUN_STATS),
    ) as { estado: string };
    expect(closed.estado).toBe("cerrado");

    const incomplete = JSON.parse(
      renderResumen(
        programmedState(),
        [
          issue({
            id: "i-001",
            claimId: "claim-c1",
            role: "segunda-fuente",
            severity: "aviso",
            estado: "sin-re-verificar",
          }),
        ],
        RUN_STATS,
      ),
    ) as { estado: string; unverifiedIssues: number };
    expect(incomplete.estado).toBe("incompleto");
    expect(incomplete.unverifiedIssues).toBe(1);

    // A gap-derived issue is `bloqueante`: closure is blocked, not merely open.
    const blockedGap = JSON.parse(
      renderResumen(
        programmedState(),
        [
          issue({
            id: "i-001",
            claimId: "claim-c1",
            role: "contadores",
            severity: "bloqueante",
            estado: "sin-re-verificar",
          }),
        ],
        RUN_STATS,
      ),
    ) as { estado: string };
    expect(blockedGap.estado).toBe("abierto");
  });
});

// ── writer + CLI wiring ───────────────────────────────────────────────────

describe("writeOutputs", () => {
  it("writes the four documented files, creating the directory", () => {
    const root = newTempDir();
    const outDir = join(root, "salidas", "v1");

    writeOutputs(outDir, programmedState(), programmedIssues(), RUN_STATS);

    for (const name of Object.values(OUTPUT_FILES)) {
      expect(existsSync(join(outDir, name))).toBe(true);
    }
    expect(readFileSync(join(outDir, OUTPUT_FILES.md), "utf8")).toContain(
      "bloqueantes: 1",
    );
    expect(readFileSync(join(outDir, OUTPUT_FILES.html), "utf8")).toContain(
      "<!doctype html>",
    );
    const evidencia = JSON.parse(
      readFileSync(join(outDir, OUTPUT_FILES.evidencia), "utf8"),
    ) as { claims: unknown[] };
    expect(evidencia.claims).toHaveLength(3);
    const resumen = JSON.parse(
      readFileSync(join(outDir, OUTPUT_FILES.resumen), "utf8"),
    ) as { estado: string; budget: number };
    expect(resumen.estado).toBe("abierto");
    expect(resumen.budget).toBe(20);
  });

  it("uses the exact file names the ecosystem expects", () => {
    expect(OUTPUT_FILES.md).toBe("reporte-final.md");
    expect(OUTPUT_FILES.html).toBe("reporte-final.html");
    expect(OUTPUT_FILES.evidencia).toBe("evidencia.json");
    expect(OUTPUT_FILES.resumen).toBe("resumen.json");
  });
});

// ── runEval run-scoped stats + CLI `-o` ───────────────────────────────────

function cliReport(claims: Claim[] = [baseClaim("claim-c1", { licencia: "Datos Generados (fixture)" })]) {
  const blocks = claims.map(
    (claim) => "```json\n" + JSON.stringify(claim, null, 2) + "\n```",
  );
  const reportPath = join(newTempDir(), "reporte.md");
  writeFileSync(
    reportPath,
    ["# Reporte de prueba (datos generados)", ...blocks].join("\n\n") + "\n",
  );
  return reportPath;
}

function okDriver(): { driver: Driver; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  const driver: Driver = async (call) => {
    calls.push(call);
    return {
      verdicts: [
        {
          claimId: "",
          role: call.role,
          resultado: "ok",
          severidad: "aviso",
          hallazgo: "",
          evidencia: [],
        },
      ],
      calls: 1,
    };
  };
  return { driver, calls };
}

async function quietly<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; stdout: string[] }> {
  const log = console.log;
  const error = console.error;
  const out: string[] = [];
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = () => {};
  try {
    return { value: await fn(), stdout: out };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("runEval stats", () => {
  it("exposes run-scoped spentThisRun/budget/cacheHits/cacheMisses", async () => {
    const cwd = newTempDir();
    const reportPath = cliReport([baseClaim("claim-c1", { licencia: "Datos Generados (fixture)" })]);

    const first = await runEval({
      reportPath,
      cwd,
      budget: 20,
      driver: okDriver().driver,
    });
    expect(first.budget).toBe(20);
    expect(first.spentThisRun).toBe(4); // one claim × four roles
    expect(first.cacheHits).toBe(0);
    expect(first.cacheMisses).toBe(4);

    const second = await runEval({
      reportPath,
      cwd,
      budget: 20,
      driver: okDriver().driver,
    });
    expect(second.spentThisRun).toBe(0);
    expect(second.cacheHits).toBe(4);
    expect(second.cacheMisses).toBe(0);

    const noCache = await runEval({
      reportPath,
      cwd,
      budget: 20,
      noCache: true,
      driver: okDriver().driver,
    });
    expect(noCache.cacheHits).toBe(0);
    expect(noCache.cacheMisses).toBe(4);
  });

  it("a resumed run keeps petitions cumulative and reports this run's spend", async () => {
    const reportPath = cliReport([
      baseClaim("claim-c1", { licencia: "Datos Generados (fixture)" }),
      baseClaim("claim-c2", { licencia: "Datos Generados (fixture)" }),
    ]);
    const cwd = dirname(reportPath);

    const first = await runEval({
      reportPath,
      cwd,
      budget: 4, // reviews claim-c1 only, then pauses
      driver: okDriver().driver,
    });
    expect(first.code).toBe(1);
    expect(first.spentThisRun).toBe(4);

    const second = await runEval({
      reportPath,
      cwd,
      budget: 20,
      driver: okDriver().driver,
    });
    expect(second.code).toBe(0);
    expect(second.spentThisRun).toBe(4); // only claim-c2's four pairs
    expect(second.state.petitions).toBe(8); // 4 + 4 across the resumed runs

    const resumen = JSON.parse(
      readFileSync(join(cwd, OUTPUT_FILES.resumen), "utf8"),
    ) as { petitions: number; spentThisRun: number; budget: number };
    expect(resumen.petitions).toBe(8);
    expect(resumen.spentThisRun).toBe(4);
    expect(resumen.budget).toBe(20);

    const md = readFileSync(join(cwd, OUTPUT_FILES.md), "utf8");
    expect(md).toContain("peticiones acumuladas: 8");
    expect(md).toContain("esta ejecución: 4 de budget 20");
    const html = readFileSync(join(cwd, OUTPUT_FILES.html), "utf8");
    expect(html).toContain("esta ejecución:</strong> 4 de budget 20");
  });
});

describe("cli eval outputs", () => {
  it("writes the four outputs under -o, creating nested directories", async () => {
    const reportPath = cliReport();
    const cwd = dirname(reportPath);
    const outDir = join(cwd, "salidas", "v1");

    const { value, stdout } = await quietly(async () =>
      main(["eval", reportPath, "-o", outDir], { cwd, driver: okDriver().driver }),
    );

    expect(value).toBe(0);
    for (const name of Object.values(OUTPUT_FILES)) {
      expect(existsSync(join(outDir, name))).toBe(true);
    }
    const resumen = JSON.parse(
      readFileSync(join(outDir, OUTPUT_FILES.resumen), "utf8"),
    ) as { estado: string };
    expect(resumen.estado).toBe("cerrado");
    expect(stdout).toEqual([]);
  });

  it("resolves a relative -o against the run's cwd, never the process cwd", async () => {
    const reportPath = cliReport();
    const cwd = dirname(reportPath);

    const { value } = await quietly(async () =>
      main(["eval", reportPath, "-o", "salidas/v1"], {
        cwd,
        driver: okDriver().driver,
      }),
    );

    expect(value).toBe(0);
    expect(existsSync(join(cwd, "salidas", "v1", OUTPUT_FILES.md))).toBe(true);
  });

  it("defaults to the report's directory when -o is absent", async () => {
    const reportPath = cliReport();
    const cwd = dirname(reportPath);

    const { value } = await quietly(async () =>
      main(["eval", reportPath], { cwd, driver: okDriver().driver }),
    );

    expect(value).toBe(0);
    for (const name of Object.values(OUTPUT_FILES)) {
      expect(existsSync(join(cwd, name))).toBe(true);
    }
  });

  it("-o without a directory is a usage error (exit 3) and runs nothing", async () => {
    const reportPath = cliReport();
    const cwd = dirname(reportPath);

    const { value } = await quietly(async () =>
      main(["eval", reportPath, "-o"], { cwd, driver: okDriver().driver }),
    );

    expect(value).toBe(3);
    expect(existsSync(join(cwd, OUTPUT_FILES.md))).toBe(false);
  });
});
