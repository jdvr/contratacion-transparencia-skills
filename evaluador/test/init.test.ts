// Tests for the init command: scaffolds <cwd>/.evaluador/ with an empty
// issues/ dir and a default config.json without overwriting an existing
// config, and prints the report contract (fenced json blocks + required
// claim fields + exit-0 conditions) to stdout.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initScripted, INIT_CONTRACT } from "../src/init.js";

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

  it("(d) prints the contract text exported as INIT_CONTRACT", async () => {
    const stdout = collector();
    const cwd = newCwd();
    const exit = await initScripted(cwd, stdout.write);
    expect(exit).toBe(0);
    expect(stdout.out).toBe(INIT_CONTRACT);
  });

  afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));
});
