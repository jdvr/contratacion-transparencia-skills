import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, parseEvalArgs } from "../src/cli.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(testDir, "..", "src");

// Captures stderr so usage-error messages can be asserted without noise.
async function caught(fn: () => Promise<number>): Promise<{
  code: number;
  stderr: string[];
}> {
  const error = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { code: await fn(), stderr: lines };
  } finally {
    console.error = error;
  }
}

describe("cli", () => {
  it("saca exit 3 para comand unknown", async () =>
    expect(await main(["nonsense"])).toBe(3));
  it("saca exit 0 para --help", async () =>
    expect(await main(["--help"])).toBe(0));
});

describe("parseEvalArgs", () => {
  it("parses the happy path values, including --roles aliases", () => {
    const parsed = parseEvalArgs([
      "reporte.md",
      "-o",
      "salida",
      "--no-cache",
      "--budget",
      "0",
      "--roles",
      "contador,falsificador",
      "--git-branches",
    ]);

    expect(parsed).toEqual({
      ok: true,
      args: {
        file: "reporte.md",
        outDir: "salida",
        noCache: true,
        gitBranches: true,
        budget: 0,
        roles: ["contadores", "falsificador"],
      },
    });
  });

  it("rejects an unknown flag naming it (typo --no-chache)", () => {
    expect(parseEvalArgs(["reporte.md", "--no-chache"])).toEqual({
      ok: false,
      message: "unknown flag: --no-chache",
    });
  });

  it("rejects a second positional argument", () => {
    expect(parseEvalArgs(["uno.md", "dos.md"])).toEqual({
      ok: false,
      message: "unexpected extra argument: dos.md",
    });
  });

  it("rejects a flag-looking value after -o or --budget", () => {
    expect(parseEvalArgs(["reporte.md", "-o", "--no-cache"])).toEqual({
      ok: false,
      message: "-o requires an output directory",
    });
    expect(parseEvalArgs(["reporte.md", "--budget", "-1"])).toEqual({
      ok: false,
      message: "--budget requires a non-negative integer",
    });
  });

  it("rejects an unknown role naming it, and accepts the canonical ids", () => {
    expect(parseEvalArgs(["reporte.md", "--roles", "contador,noexiste"])).toEqual({
      ok: false,
      message: "unknown role: noexiste",
    });
    const canonical = parseEvalArgs(["reporte.md", "--roles", "segunda-fuente,metodico"]);
    expect(canonical).toMatchObject({
      ok: true,
      args: { roles: ["segunda-fuente", "metodico"] },
    });
  });

  it("still requires the report path and a non-empty --roles value", () => {
    expect(parseEvalArgs(["--no-cache"])).toEqual({
      ok: false,
      message: "eval requires a report file path",
    });
    expect(parseEvalArgs(["reporte.md", "--roles", "--no-cache"])).toEqual({
      ok: false,
      message: "--roles requires a comma-separated role list",
    });
  });
});

describe("cli strict usage errors", () => {
  it("an unknown flag exits 3 with a message naming it", async () => {
    const { code, stderr } = await caught(() => main(["eval", "reporte.md", "--no-chache"]));
    expect(code).toBe(3);
    expect(stderr.join("\n")).toContain("unknown flag: --no-chache");
  });

  it("extra positionals exit 3 without running anything", async () => {
    const { code, stderr } = await caught(() => main(["eval", "uno.md", "dos.md"]));
    expect(code).toBe(3);
    expect(stderr.join("\n")).toContain("unexpected extra argument: dos.md");
  });
});

// npm-bin invocation contract: installed bins run through a symlink
// (node_modules/.bin/evaluador -> dist/cli.js), so exit codes and output must
// propagate even when process.argv[1] is the symlinked path.
describe("cli via npm-bin symlink", () => {
  const skip = process.platform === "win32"; // symlinks need privileges on win32
  (skip ? describe.skip : describe)("compiled binary", () => {
    let tempRoot = "";
    let cliJs = ""; // the bundled, non-symlinked entry
    let binSymlink = ""; // npm-bin style symlink to cliJs

    beforeAll(async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "evaluador-test-"));
      cliJs = join(tempRoot, "dist-cli.js");
      binSymlink = join(tempRoot, "bin", "evaluador");

      const { build } = await import("esbuild");
      await build({
        entryPoints: [join(srcDir, "cli.ts")],
        outfile: cliJs,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        banner: { js: "#!/usr/bin/env node" },
      });

      mkdirSync(dirname(binSymlink), { recursive: true });
      symlinkSync(cliJs, binSymlink);
    });

    it("propaga exit 3 y mensaje de stderr para comando unknown", () => {
      const res = spawnSync(process.execPath, [binSymlink, "nonsense"], { encoding: "utf8" });
      expect(res.status).toBe(3);
      expect(res.stderr).toMatch(/unknown command: nonsense/);
      expect(res.stdout).toBe("");
    });

    it("propaga exit 0 y usage en stdout para --help", () => {
      const res = spawnSync(process.execPath, [binSymlink, "--help"], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      expect(res.stdout).toMatch(/^Usage: evaluador/);
    });

    afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));
  });
});
