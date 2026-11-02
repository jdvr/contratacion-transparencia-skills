// Tests for Task 7: canonicalJson + contentHash (state.ts) and the
// content-addressed VerdictCache (cache.ts). Scenarios follow the brief
// (a-c); (b) is the Review Focus #2 guard: the rubric version is part of
// the hash payload, so a bump (rubricV1 → rubricV2) invalidates the cache.
// Tempdirs are collected and removed EVERY time (no leaks, cf. Task 4).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "../src/state.js";
import { VerdictCache } from "../src/cache.js";
import type { Verdict } from "../src/driver/types.js";
import type { Claim } from "../src/contract.js";

// One complete claim as a parsed Claim would look (fixture-style, fake data).
function makeClaim(id: string): Claim {
  return {
    id,
    afirmacion: "afirmación ficticia de prueba (dato generado)",
    cifra: "0,00 €",
    fuente: "Fuente Generada de Prueba",
    url: "https://datos.canarias.es/ejemplo-generado",
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

function makeVerdict(claimId: string, role: string): Verdict {
  return {
    claimId,
    role,
    resultado: "ok",
    severidad: "aviso",
    hallazgo: "hallazgo ficticio de prueba (dato generado)",
    evidencia: ["evidencia-1", "evidencia-2"],
  };
}

const tempRoots = new Set<string>();

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evaluador-cache-test-"));
  tempRoots.add(dir);
  return dir;
}

describe("canonicalJson and contentHash", () => {
  it("(a) same claim, two calls ⇒ identical hash; changing ONE field ⇒ different", () => {
    const claim = makeClaim("claim-a");
    const h1 = contentHash({ claim, rubricVersion: "rubricV1" });
    const h2 = contentHash({ claim, rubricVersion: "rubricV1" });
    expect(h1).toBe(h2);

    const changed = { ...claim, cifra: "1,00 €" };
    expect(contentHash({ claim: changed, rubricVersion: "rubricV1" })).not.toBe(h1);
  });

  it("(a) key order does not matter: same entries in different order ⇒ identical hash", () => {
    const a = { z: 1, m: { y: 2, b: 3 }, a: [1, 2] };
    const b = { a: [1, 2], m: { b: 3, y: 2 }, z: 1 };
    expect(contentHash(a)).toBe(contentHash(b));
    // The canonical form itself is key-sorted; arrays keep their order.
    expect(canonicalJson(b)).toBe('{"a":[1,2],"m":{"b":3,"y":2},"z":1}');
    expect(canonicalJson({ arr: [1, 2] })).not.toBe(canonicalJson({ arr: [2, 1] }));
  });

  it("(a) JSON-ish scalars: numbers, booleans, null; undefined: dropped in objects, null in arrays", () => {
    expect(canonicalJson({ n: 1.5, b: true, z: null })).toBe('{"b":true,"n":1.5,"z":null}');
    // undefined values in objects are dropped (like JSON.stringify's own
    // treatment); undefined inside arrays serializes to null.
    expect(canonicalJson({ keep: 1, drop: undefined })).toBe('{"keep":1}');
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("(b) Review Focus #2: equal claims, different rubricVersion ⇒ different hash", () => {
    const claim = makeClaim("claim-b");
    const v1 = contentHash({ claim, rubricVersion: "rubricV1" });
    const v2 = contentHash({ claim, rubricVersion: "rubricV2" });
    expect(v1).not.toBe(v2);
    // The hash is sha256 hex (64 chars, hex alphabet).
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("VerdictCache", () => {
  it("(c) put + save + new instance over the same path ⇒ get returns this Verdict", () => {
    const path = join(newTempDir(), ".evaluador", "cache.json");
    const claim = makeClaim("claim-c");
    const hash = contentHash({ claim, rubricVersion: "rubricV1" });
    const verdict = makeVerdict("claim-c", "metodico");
    const model = "modelo-generado-de-prueba";
    const updatedAt = "2026-11-02T00:00:00.000Z";

    const cache = new VerdictCache(path);
    expect(cache.get(hash, "metodico")).toBeUndefined(); // miss before put
    cache.put(hash, "metodico", verdict, model, updatedAt);
    cache.save();

    // The file really exists on disk with the stored record.
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      Record<string, { verdict: Verdict; model: string; updatedAt: string }>
    >;
    expect(stored[hash]?.metodico).toEqual({ verdict, model, updatedAt });

    // A fresh instance lazily re-reads the saved file: roundtrip holds.
    const revived = new VerdictCache(path);
    expect(revived.get(hash, "metodico")).toEqual(verdict);
    expect(revived.get(hash, "contadores")).toBeUndefined(); // other role missed
  });

  it("unknown role on get returns undefined, never throws", () => {
    const path = join(newTempDir(), ".evaluador", "cache.json");
    const cache = new VerdictCache(path);
    expect(cache.get("deadbeef", "rol-inexistente" as never)).toBeUndefined();
    expect(existsSync(path)).toBe(false); // lazy: nothing is written on a bare get
  });
});

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});
