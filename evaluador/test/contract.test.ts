// Tests for the report contract: Claim type and the fenced-json parser.
// The fixture carries fictional/generated data only (see its header label).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClaims } from "../src/contract.js";

const fixture = new URL("./fixtures.reporte.md", import.meta.url);
const fixtureMd = readFileSync(fixture, "utf8");

// The three generated claims from the fixture, in document order, with the
// exact field values declared there (fictional data; see the fixture header).
const fixtureClaims = [
  {
    id: "claim-ficticio-001",
    afirmacion:
      "El Órgano Ficticio A adjudicó 1.000.000,00 € a la Sociedad Ficticia Uno S.L. (NIF 555XXXXXX) durante el ejercicio ficticio 2025.",
    cifra: "1.000.000,00 €",
    fuente: "Portal Generado de Adjudicaciones",
    url: "https://example.com/generados/claim-001",
    fecha_dato: "2025-06-30",
    fecha_consulta: "2026-11-01",
    criterio:
      "Todas las adjudicaciones del dataset generado con importe >= 1.000.000,00 €.",
    filas_traidas: 10,
    conteo_declarado: 10,
    banderas: [],
    dedup: false,
    etiqueta: "VERIFICADO",
    licencia: "Fuente: Datos Generados (fixture de prueba)",
  },
  {
    id: "claim-ficticio-002",
    afirmacion:
      "La Sociedad Ficticia Dos S.L. (NIF 555XXXXXX) facturó 2.000.000,00 € en el primer semestre ficticio.",
    fuente: "CSV Generado Truncado",
    url: "https://example.com/generados/claim-002",
    fecha_dato: "2025-12-31",
    fecha_consulta: "2026-11-01",
    criterio:
      "Suma de la columna importe del CSV generado, sin IGIC ni anualidades.",
    filas_traidas: 500,
    conteo_declarado: 60000,
    banderas: ["CSV truncado"],
    dedup: true,
    etiqueta: "HIPÓTESIS",
  },
  {
    id: "claim-ficticio-003",
    afirmacion: "Quedan 3.000 personas ficticias en lista de espera generada.",
    cifra: "3.000 personas",
    fuente: "Registro Generado de Listas de Espera",
    url: "https://example.com/generados/claim-003",
    fecha_dato: "2025-03-31",
    fecha_consulta: "2026-11-01",
    criterio: "Personas del registro generado a fecha ficticia de corte.",
    banderas: [],
    dedup: false,
    etiqueta: "PENDIENTE",
  },
] as const;

describe("parseClaims on the generated fixture", () => {
  it("extrae los 3 claims con los campos exactos del fixture, en orden", () => {
    const { claims, parseErrors } = parseClaims(fixtureMd);
    expect(claims).toEqual(fixtureClaims);
    expect(parseErrors).toEqual([]);
  });
});

describe("parseClaims validation", () => {
  it("banderas completamente ausente => parseErrors; banderas: [] explícito vale", () => {
    const md = [
      "Prose line, no fence around it.",
      "```json",
      JSON.stringify({ ...fixtureClaims[0], id: "sin-banderas", banderas: undefined }),
      "```",
      "```json",
      JSON.stringify({ ...fixtureClaims[1], id: "sin-banderas-vacio", banderas: [] }),
      "```",
    ].join("\n");
    const { claims, parseErrors } = parseClaims(md);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.id).toBe("sin-banderas-vacio");
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toMatch(/sin-banderas/);
    expect(parseErrors[0]).toMatch(/banderas/);
  });
});

describe("parseClaims resilience", () => {
  it("un fence con JSON malformado va a parseErrors y no rompe el resto", () => {
    const md = [
      "```json",
      JSON.stringify({ ...fixtureClaims[0], id: "antes-del-error" }),
      "```",
      "```json",
      "{ id: not valid JSON }", // malformed: no quotes, no braces on trailing
      "```",
      "```json",
      JSON.stringify({ ...fixtureClaims[2], id: "despues-del-error" }),
      "```",
    ].join("\n");
    const { claims, parseErrors } = parseClaims(md);
    expect(claims).toEqual([
      { ...fixtureClaims[0], id: "antes-del-error" },
      { ...fixtureClaims[2], id: "despues-del-error" },
    ]);
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toMatch(/invalid JSON/i);
  });

  it("prose sin fences => claims.length === 0 y sin errores", () => {
    const md = [
      "Un informe de mera prosa.",
      "Párrafos, listas:",
      "- un elemento",
      "y `código en línea` pero ningún bloque fenced `json`.",
    ].join("\n");
    const { claims, parseErrors } = parseClaims(md);
    expect(claims).toHaveLength(0);
    expect(parseErrors).toEqual([]);
  });

  it("id duplicado => el repetido va a parseErrors y se conserva el primero", () => {
    const md = [
      "```json",
      JSON.stringify({ ...fixtureClaims[0], id: "claim-duplicado" }),
      "```",
      "```json",
      JSON.stringify({ ...fixtureClaims[1], id: "claim-duplicado" }),
      "```",
    ].join("\n");
    const { claims, parseErrors } = parseClaims(md);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.etiqueta).toBe("VERIFICADO");
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toMatch(/claim-duplicado/);
  });

  it("fence json sin id => se ignora, no es un claim ni un error", () => {
    const md = [
      "```json",
      '{"titulo": "Anexo generado", "descripcion": "sin id a propósito"}',
      "```",
    ].join("\n");
    const { claims, parseErrors } = parseClaims(md);
    expect(claims).toHaveLength(0);
    expect(parseErrors).toEqual([]);
  });
});
