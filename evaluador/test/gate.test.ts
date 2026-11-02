// Tests for the deterministic structural gate: what the parser leaves optional
// becomes mandatory here depending on the claim's honest label. Gap razons are
// exact, machine-parseable strings (see brief rules 1-5).
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runGate } from "../src/gate.js";
import { main } from "../src/cli.js";

const fixtureMd = readFileSync(
  new URL("./fixtures.reporte.md", import.meta.url),
  "utf8",
);

// One valid VERIFICADO claim as a fenced json block, with overrides. A value
// of undefined is dropped by JSON.stringify, so the field reads as absent.
function claimMd(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    id: "claim-gate-test",
    afirmacion: "afirmación ficticia de prueba (dato generado)",
    cifra: "0,00 €",
    fuente: "Fuente Generada de Prueba",
    url: "https://example.com/generados/gate-test",
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
  for (const [key, value] of Object.entries(overrides)) base[key] = value;
  return "```json\n" + JSON.stringify(base, null, 2) + "\n```";
}

describe("gate rule 2: cifra/filas/conteo required only for VERIFICADO", () => {
  it("(a) VERIFICADO without cifra => gap {campo: 'cifra'} for its claim", () => {
    const { ok, gaps } = runGate(claimMd({ cifra: undefined }));
    expect(ok).toBe(false);
    expect(gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "cifra",
      razon: "falta",
    });
  });

  it("(c) PENDIENTE without cifra/licencia/filas/conteo => ok, zero gaps", () => {
    const { ok, gaps, claims } = runGate(
      claimMd({
        cifra: undefined,
        filas_traidas: undefined,
        conteo_declarado: undefined,
        licencia: undefined,
        etiqueta: "PENDIENTE",
      }),
    );
    expect(gaps).toEqual([]);
    expect(ok).toBe(true);
    expect(claims).toHaveLength(1);
  });

  it("HIPÓTESIS y NO CONCLUYENTE sin cifra también son legítimos", () => {
    for (const etiqueta of ["HIPÓTESIS", "NO CONCLUYENTE"]) {
      const { ok, gaps } = runGate(
        claimMd({
          cifra: undefined,
          filas_traidas: undefined,
          conteo_declarado: undefined,
          licencia: undefined,
          etiqueta,
        }),
      );
      expect(gaps).toEqual([]);
      expect(ok).toBe(true);
    }
  });
});

describe("gate rule 3: filas_traidas vs conteo_declarado", () => {
  it("(b) 2112 > 1500 => gap with razon 'supera conteo declarado'", () => {
    const { ok, gaps } = runGate(
      claimMd({ filas_traidas: 2112, conteo_declarado: 1500 }),
    );
    expect(ok).toBe(false);
    expect(gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "filas_traidas",
      razon: "supera conteo declarado",
    });
  });

  it("filas_traidas == conteo_declarado produces no gap", () => {
    const { gaps } = runGate(
      claimMd({ filas_traidas: 1500, conteo_declarado: 1500 }),
    );
    expect(gaps).toEqual([]);
  });

  it("paired filas/conteo: one present, the other absent => gap 'falta'", () => {
    const withoutConteo = runGate(
      claimMd({ conteo_declarado: undefined, filas_traidas: 5 }),
    );
    expect(withoutConteo.gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "conteo_declarado",
      razon: "falta",
    });
    const withoutFilas = runGate(
      claimMd({
        conteo_declarado: 5,
        filas_traidas: undefined,
        etiqueta: "PENDIENTE",
      }),
    );
    expect(withoutFilas.gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "filas_traidas",
      razon: "falta",
    });
  });
});

describe("gate rule 4: date formats", () => {
  it("(d) fecha_consulta '2026-10' => gap 'no es ISO AAAA-MM-DD' and fecha_dato '2026' is fine", () => {
    const { ok, gaps } = runGate(claimMd({ fecha_consulta: "2026-10" }));
    expect(ok).toBe(false);
    expect(gaps.filter((g) => g.campo === "fecha_dato")).toEqual([]);
    const gap = gaps.find((g) => g.campo === "fecha_consulta");
    expect(gap?.razon).toMatch(/no es ISO AAAA-MM-DD/);
  });

  it("fecha_consulta with month/day out of range also fails the strict ISO check", () => {
    const { ok, gaps } = runGate(claimMd({ fecha_consulta: "2026-13-40" }));
    expect(ok).toBe(false);
    expect(gaps.find((g) => g.campo === "fecha_consulta")?.razon).toMatch(
      /no es ISO AAAA-MM-DD/,
    );
  });

  it("fecha_dato '2025-13' is not AAAA / AAAA-MM / AAAA-MM-DD", () => {
    const { gaps } = runGate(claimMd({ fecha_dato: "2025-13" }));
    expect(gaps.filter((g) => g.campo === "fecha_dato")).toHaveLength(1);
    expect(gaps.find((g) => g.campo === "fecha_dato")?.razon).toMatch(
      /no es AAAA/,
    );
  });
});

describe("gate rule 1: always-required fields", () => {
  it("missing url => gap {campo: 'url', razon: 'falta'} (Review Focus #1 shape)", () => {
    const { ok, gaps } = runGate(claimMd({ url: undefined }));
    expect(ok).toBe(false);
    expect(gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "url",
      razon: "falta",
    });
  });

  it("wrong-typed always-required field => gap 'no es string'", () => {
    const { ok, gaps } = runGate(claimMd({ criterio: 42 }));
    expect(ok).toBe(false);
    expect(gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "criterio",
      razon: "no es string",
    });
  });
});

describe("gate rule 5: licencia, duplicate ids and parse errors become gaps", () => {
  it("VERIFICADO without licencia => gap {campo: 'licencia', razon: 'falta'}", () => {
    const { ok, gaps } = runGate(claimMd({ licencia: undefined }));
    expect(ok).toBe(false);
    expect(gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "licencia",
      razon: "falta",
    });
  });

  it("duplicate id and malformed fence each surface as a parse gap", () => {
    const md = [
      claimMd({ id: "claim-duplicado" }),
      claimMd({ id: "claim-duplicado", cifra: undefined }),
      "```json",
      "{ id: not valid JSON }",
      "```",
    ].join("\n");
    const { ok, gaps, claims } = runGate(md);
    expect(ok).toBe(false);
    expect(claims).toHaveLength(1); // first duplicate kept, as the parser does
    const duplicate = gaps.find((g) => g.campo === "parse" && g.claim !== undefined);
    expect(duplicate?.claim).toBe("claim-duplicado");
    expect(duplicate?.razon).toMatch(/duplicate id/);
    const malformed = gaps.filter((g) => g.campo === "parse" && g.claim === undefined);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.razon).toMatch(/invalid JSON/i);
  });
});

describe("gate as the second layer over the parser cast (Task 2 note)", () => {
  it("revalidates claim types the parser's cast lets through: dedup, etiqueta, numbers", () => {
    const { ok, gaps } = runGate(
      claimMd({ dedup: "no", etiqueta: "CHECK", filas_traidas: "muchas" }),
    );
    expect(ok).toBe(false);
    expect(gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "dedup",
      razon: "no es booleano",
    });
    expect(gaps.find((g) => g.campo === "etiqueta")?.razon).toMatch(
      /etiqueta no válida/,
    );
    expect(gaps.find((g) => g.campo === "filas_traidas")?.razon).toMatch(
      /no es número/,
    );
  });
});

describe("gate on the untouched generated fixture", () => {
  it("(e) fixture passes runGate with ok: true and zero gaps", () => {
    const { ok, gaps, claims } = runGate(fixtureMd);
    expect(gaps).toEqual([]);
    expect(ok).toBe(true);
    expect(claims).toHaveLength(3);
  });

  it("a report with zero claims FAILS the gate (spec fallback: nothing to evaluate)", () => {
    const { ok, gaps, claims } = runGate("");
    expect(ok).toBe(false);
    expect(claims).toHaveLength(0);
    expect(gaps).toEqual([
      { campo: "claims", razon: "el reporte no contiene ninguna afirmación evaluada" },
    ]);
  });

  it("zero claims plus parse errors: parse gaps first, then the zero-claims gap", () => {
    const { ok, gaps, claims } = runGate("```json\n{ id: not valid JSON }\n```");
    expect(ok).toBe(false);
    expect(claims).toHaveLength(0);
    expect(gaps).toEqual([
      expect.objectContaining({ campo: "parse" }),
      { campo: "claims", razon: "el reporte no contiene ninguna afirmación evaluada" },
    ]);
  });
});

describe("cli eval wiring", () => {
  let tempRoot = "";
  afterAll(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  function tmpReport(name: string, md: string): string {
    tempRoot ||= mkdtempSync(join(tmpdir(), "evaluador-gate-cli-"));
    const path = join(tempRoot, name);
    writeFileSync(path, md);
    return path;
  }

  async function runCapturingEval(args: string[]): Promise<{ code: number; stdoutLines: string[] }> {
    const stdoutLines: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => stdoutLines.push(String(message));
    try {
      const code = await main(args);
      return { code, stdoutLines };
    } finally {
      console.log = originalLog;
    }
  }

  function jsonOut(stdoutLines: string[]): { ok: boolean; gaps: unknown[]; claims: number } {
    // pick the line that parses as JSON (usage/banner text is ignored if any)
    const jsonLines = stdoutLines.filter((line) => line.startsWith("{"));
    expect(jsonLines).toHaveLength(1);
    return JSON.parse(jsonLines[0] ?? "null");
  }

  it("gate fail => exit 2 with gaps JSON on stdout", async () => {
    const path = tmpReport("falla.md", "REPORTE (DATOS GENERADOS)\n" + claimMd({ cifra: undefined }));
    const { code, stdoutLines } = await runCapturingEval(["eval", path]);
    expect(code).toBe(2);
    const out = jsonOut(stdoutLines);
    expect(out.ok).toBe(false);
    expect(out.gaps).toContainEqual({
      claim: "claim-gate-test",
      campo: "cifra",
      razon: "falta",
    });
  });

  it("gate pass => temporarily exit 0 (phases 2+ arrive with Task 8)", async () => {
    const path = tmpReport("pasa.md", "REPORTE (DATOS GENERADOS)\n" + claimMd());
    const { code, stdoutLines } = await runCapturingEval(["eval", path]);
    expect(code).toBe(0);
    const out = jsonOut(stdoutLines);
    expect(out).toEqual({ ok: true, gaps: [], claims: 1 });
  });

  it("unreadable report file => exit 3 (usage/parse)", async () => {
    const { code, stdoutLines } = await runCapturingEval([
      "eval",
      join(tempRoot, "que-no-existe.md"),
    ]);
    expect(code).toBe(3);
    expect(stdoutLines.filter((line) => line.startsWith("{"))).toEqual([]);
  });

  it("eval without a file argument => exit 3 (usage)", async () => {
    const { code } = await runCapturingEval(["eval"]);
    expect(code).toBe(3);
  });

  it("empty report (zero claims) => exit 2 with the zero-claims gap JSON", async () => {
    const path = tmpReport("vacio.md", "REPORTE (DATOS GENERADOS) sin bloques json");
    const { code, stdoutLines } = await runCapturingEval(["eval", path]);
    expect(code).toBe(2);
    const out = jsonOut(stdoutLines);
    expect(out).toEqual({
      ok: false,
      gaps: [
        { campo: "claims", razon: "el reporte no contiene ninguna afirmación evaluada" },
      ],
      claims: 0,
    });
  });
});
