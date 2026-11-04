// Tests for the init command: scaffolds <cwd>/.evaluador/ with an empty
// issues/ dir and a default config.json without overwriting an existing
// config, and prints the report contract (fenced json blocks + required
// claim fields + exit-0 conditions) to stdout.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initScripted, INIT_CONTRACT, INIT_DOC } from "../src/init.js";

let tempRoot = "";

function newCwd(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "evaluador-init-test-"));
  return tempRoot;
}

// stdout collector standing in for the CLI's console.log-wrapping writer.
function collector(): { out: string; write: (s: string) => void } {
  let buffer = "";
  return {
    get out(): string {
      return buffer;
    },
    write(s: string): void {
      buffer += s;
    },
  };
}

describe("init", () => {
  it("(a) scaffolds .evaluador/ with config {\"budget\": 20} and empty issues/", async () => {
    const stdout = collector();
    const cwd = newCwd();
    const exit = await initScripted(cwd, stdout.write);
    expect(exit).toBe(0);
    expect(existsSync(join(cwd, ".evaluador", "config.json"))).toBe(true);
    expect(readFileSync(join(cwd, ".evaluador", "config.json"), "utf8")).toBe('{"budget": 20}\n');
    expect(existsSync(join(cwd, ".evaluador", "issues"))).toBe(true);
  });

  it("(b) re-run on cwd with existing config leaves the file byte-identical", async () => {
    const stdout = collector();
    const cwd = newCwd();
    await initScripted(cwd, stdout.write);
    writeFileSync(join(cwd, ".evaluador", "config.json"), '{"budget": 99}\n');
    await initScripted(cwd, stdout.write);
    expect(readFileSync(join(cwd, ".evaluador", "config.json"), "utf8")).toBe('{"budget": 99}\n');
  });

  it("(c) prints the contract: contains 'banderas' and 'NO CONCLUYENTE'", async () => {
    const stdout = collector();
    const cwd = newCwd();
    await initScripted(cwd, stdout.write);
    expect(stdout.out).toContain("banderas");
    expect(stdout.out).toContain("NO CONCLUYENTE");
  });

  it("(d) prints the contract plus the usage guide (INIT_DOC)", async () => {
    const stdout = collector();
    const cwd = newCwd();
    const exit = await initScripted(cwd, stdout.write);
    expect(exit).toBe(0);
    expect(stdout.out).toBe(INIT_DOC);
    expect(stdout.out).toContain(INIT_CONTRACT);
  });

  it("(e) persiste el mismo documento en .evaluador/CONTRATO.md", async () => {
    const stdout = collector();
    const cwd = newCwd();
    await initScripted(cwd, stdout.write);
    const doc = join(cwd, ".evaluador", "CONTRATO.md");
    expect(existsSync(doc)).toBe(true);
    expect(readFileSync(doc, "utf8")).toBe(INIT_DOC);
  });

  it("(f) el documento explica flags, config, multi-URL, roles, artefactos y exit 3", async () => {
    const stdout = collector();
    await initScripted(newCwd(), stdout.write);
    for (const token of [
      "--jobs",
      "--no-cache",
      "--roles",
      "--model",
      "--timeout",
      "--git-branches",
      "allowHosts",
      "una o varias URLs",
      "segunda-fuente",
      "reporte-final.md",
      "exit 3",
    ]) {
      expect(stdout.out, `init should document ${token}`).toContain(token);
    }
  });

  it("(g) re-run refresca CONTRATO.md pero nunca toca config.json", async () => {
    const stdout = collector();
    const cwd = newCwd();
    await initScripted(cwd, stdout.write);
    writeFileSync(join(cwd, ".evaluador", "CONTRATO.md"), "doc viejo\n");
    writeFileSync(join(cwd, ".evaluador", "config.json"), '{"budget": 99}\n');
    await initScripted(cwd, stdout.write);
    expect(readFileSync(join(cwd, ".evaluador", "CONTRATO.md"), "utf8")).toBe(INIT_DOC);
    expect(readFileSync(join(cwd, ".evaluador", "config.json"), "utf8")).toBe('{"budget": 99}\n');
  });

  afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));
});
