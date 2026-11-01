import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(testDir, "..", "src");

describe("cli", () => {
  it("saca exit 3 para comand unknown", async () =>
    expect(await main(["nonsense"])).toBe(3));
  it("saca exit 0 para --help", async () =>
    expect(await main(["--help"])).toBe(0));
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
