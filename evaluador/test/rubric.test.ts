// Tests for rubricV1: the versioned role rubrics and the fetch allowlist.
// Scenarios follow the brief (a-d); the pinned strings ("criterio del total",
// "GROUP BY") are the domain-checklist tokens the spec's controls are named by.
// resolveFetch is host-EXACT: no subdomain matching, no "www." normalization.
import { describe, expect, it } from "vitest";
import {
  ALLOWED_HOSTS,
  DEFAULT_ROLES,
  ROLE_ALIASES,
  ROLE_DISPLAY_NAMES,
  RUBRIC_VERSION,
  rubricFor,
  resolveFetch,
} from "../src/rubric.js";
import type { RoleId } from "../src/rubric.js";
import type { Claim } from "../src/contract.js";

// One complete claim as a parsed Claim would look (fixture-style, fake data).
function makeClaim(url: string): Claim {
  return {
    id: "claim-test",
    afirmacion: "afirmación ficticia de prueba (dato generado)",
    cifra: "0,00 €",
    fuente: "Fuente Generada de Prueba",
    url,
    fecha_dato: "2025",
    fecha_consulta: "2026-11-01",
    criterio: "criterio ficticio del total para la prueba",
    filas_traidas: 5,
    conteo_declarado: 10,
    banderas: [],
    dedup: false,
    etiqueta: "PENDIENTE",
  };
}

describe("rubric version and role registry", () => {
  it("(a) RUBRIC_VERSION is exactly 'rubricV1'", () => {
    expect(RUBRIC_VERSION).toBe("rubricV1");
  });

  it("(b) alias contador→contadores exists and 'contadores' is a valid RoleId", () => {
    expect(ROLE_ALIASES.contador).toBe("contadores");
    // 'contadores' as a RoleId: rubricFor accepts it (compile-time plus runtime).
    expect(DEFAULT_ROLES).toContain("contadores" as RoleId);
    expect(rubricFor("contadores").length).toBeGreaterThan(0);
  });

  it("(b) default roles are the four spec roles, ASCII ids", () => {
    expect(DEFAULT_ROLES).toEqual([
      "contadores",
      "segunda-fuente",
      "falsificador",
      "metodico",
    ]);
    // Every alias maps to a default role (no alias to a role outside the set).
    for (const roleId of Object.values(ROLE_ALIASES)) {
      expect(DEFAULT_ROLES).toContain(roleId);
    }
  });

  it("(b) 'metodico' is the ASCII id; humans are shown 'metódico'", () => {
    expect(ROLE_DISPLAY_NAMES.metodico).toBe("metódico");
  });
});

describe("rubricFor(role): role judgment prompts", () => {
  it("(c) contadores mentions 'criterio del total' and the count-vs-declared check", () => {
    const rubric = rubricFor("contadores");
    expect(rubric).toContain("criterio del total");
    // Rows vs declared, and the mixing controls from the spec.
    expect(rubric).toContain("filas_traidas");
    expect(rubric).toContain("conteo_declarado");
    expect(rubric).toContain("IGIC");
    expect(rubric).toContain("anualidad");
    expect(rubric).toContain("factur");
  });

  it("(c) falsificador mentions 'GROUP BY' and its falsification controls", () => {
    const rubric = rubricFor("falsificador");
    expect(rubric).toContain("GROUP BY");
    expect(rubric).toContain("GROUP BY alternativo");
    expect(rubric.toLowerCase()).toContain("inverse filter");
    expect(rubric.toLowerCase()).toContain("exclude");
  });

  it("segunda-fuente contrasts via a logically distinct route", () => {
    const rubric = rubricFor("segunda-fuente");
    expect(rubric).toContain("CKAN");
    expect(rubric).toContain("CSV");
    expect(rubric).toContain("PLACSP");
    expect(rubric).toContain("BOE");
    expect(rubric).toContain("TED");
  });

  it("metodico covers declared coverage, requests, container/encoding, honest labels", () => {
    const rubric = rubricFor("metodico");
    const lower = rubric.toLowerCase();
    expect(lower).toContain("coverage");
    expect(lower).toContain("request budget");
    expect(lower).toContain("encoding");
    expect(rubric).toContain("VERIFICADO");
    expect(lower).toContain("labels");
  });

  it("every role rubric echoes the verdict schema and demands JSON-only output", () => {
    for (const role of DEFAULT_ROLES) {
      const rubric = rubricFor(role);
      for (const field of [
        "claimId",
        "role",
        '"resultado"',
        '"severidad"',
        "hallazgo",
        "evidencia",
      ]) {
        expect(rubric, `rubric for ${role} mentions ${field}`).toContain(field);
      }
      for (const outcome of ["ok", "problema", "sin-re-verificar"]) {
        expect(rubric).toContain(outcome);
      }
      expect(rubric, "rubric forbids any non-JSON output").toContain(
        "single JSON object",
      );
    }
  });

  it("every rubric pins the citizen-not-crawler stance: allowlist only", () => {
    for (const role of DEFAULT_ROLES) {
      expect(rubricFor(role).toLowerCase()).toContain("allowlist");
    }
  });

  it("unknown role throws (runtime guard over the typed seam)", () => {
    expect(() => rubricFor("noexiste" as RoleId)).toThrow();
  });
});

describe("ALLOWED_HOSTS: the exact-domain allowlist", () => {
  it("is the exact spec list", () => {
    expect([...ALLOWED_HOSTS]).toEqual([
      "datos.canarias.es",
      "gobiernodecanarias.org",
      "contrataciondelestado.es",
      "boe.es",
      "ted.europa.eu",
    ]);
  });
});

describe("resolveFetch(claim)", () => {
  it("(d) a datos.canarias.es URL is allowed", () => {
    const url = "https://datos.canarias.es/api/3/action/package_search?q=test";
    const { allowed, blocked } = resolveFetch(makeClaim(url));
    expect(allowed).toEqual([url]);
    expect(blocked).toEqual([]);
  });

  it("(d) an example.com URL is blocked and NOT in allowed", () => {
    const url = "https://example.com/some-dataset.csv";
    const { allowed, blocked } = resolveFetch(makeClaim(url));
    expect(blocked).toEqual([url]);
    expect(allowed).not.toContain(url);
  });

  it("multiple space-separated URLs are each routed", () => {
    const url =
      "https://datos.canarias.es/a.csv https://boe.es/b.pdf https://example.org/c";
    const { allowed, blocked } = resolveFetch(makeClaim(url));
    expect(allowed).toEqual([
      "https://datos.canarias.es/a.csv",
      "https://boe.es/b.pdf",
    ]);
    expect(blocked).toEqual(["https://example.org/c"]);
  });

  it("host matching is exact: no subdomains, no www normalization", () => {
    const { allowed } = resolveFetch(
      makeClaim("https://www.datos.canarias.es/a https://datos.canarias.es.evil.com/b"),
    );
    expect(allowed).toEqual([]);
  });

  it("scheme-agnostic on the allowed host: any scheme passes, host decides", () => {
    const { allowed } = resolveFetch(
      makeClaim("http://ted.europa.eu/en/notice/-/detail/123"),
    );
    expect(allowed).toEqual(["http://ted.europa.eu/en/notice/-/detail/123"]);
  });

  it("a token without a scheme is still checked against its host", () => {
    const { allowed, blocked } = resolveFetch(
      makeClaim("datos.canarias.es/x example.com/y"),
    );
    expect(allowed).toEqual(["datos.canarias.es/x"]);
    expect(blocked).toEqual(["example.com/y"]);
  });

  it("garbage tokens land in blocked, never in allowed", () => {
    const { allowed, blocked } = resolveFetch(makeClaim(":: malformado"));
    // Tokens split on whitespace; each garbage token is routed independently.
    expect(allowed).toEqual([]);
    expect(blocked).toEqual(["::", "malformado"]);
  });

  it("empty or whitespace-only url yields nothing to fetch", () => {
    expect(resolveFetch(makeClaim(""))).toEqual({ allowed: [], blocked: [] });
    expect(resolveFetch(makeClaim("   ")).allowed).toEqual([]);
  });
});
