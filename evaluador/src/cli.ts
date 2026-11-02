// evaluador CLI entry point.
// Exit codes: 0 = closure complete, 1 = verification finished with deltas or a
// declared gap, 2 = structural gate failed, 3 = usage / unreadable report.
// See docs/superpowers/specs/2026-10-31-evaluador-design.md.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval } from "./adversarial.js";
import { opencodeDriver } from "./driver/opencode.js";
import type { Driver } from "./driver/types.js";
import { initScripted } from "./init.js";

const EXIT_OK = 0;
const EXIT_UNKNOWN_COMMAND = 3;
const EXIT_GATE_FAILED = 2;

// Request budget used when no `--budget` flag is given and `.evaluador/config.json`
// is missing, unreadable or corrupt: fail open to init's documented default.
const DEFAULT_BUDGET = 20;

// Test seam over the real process: the CLI defaults to the real driver and the
// process cwd, while tests inject a fake driver and a tempdir. Keeps the
// documented `main(args)` call shape intact.
export interface MainDeps {
  cwd?: string;
  driver?: Driver;
  timeoutMs?: number;
}

// init: prints the report contract (INIT_CONTRACT) and scaffolds .evaluador/
// in the process cwd. stdout is written directly: initScripted's chunks carry
// their own trailing newlines (no printUsage/console.log double-spacing).
async function runInit(_args: string[]): Promise<number> {
  return initScripted(process.cwd(), (s) => process.stdout.write(s));
}

// eval <file> [--no-cache] [--budget N]: runs the structural gate and, when it
// passes, the adversarial phases via runEval. The process exit code is runEval's
// own (0/1), gate failure stays 2 (gaps JSON on stdout for the invoking model),
// and an unreadable report or a malformed flag is a usage error (3). Full report
// artifacts arrive in Task 11, so 0/1 are exit-only for now.
async function runEvalCommand(args: string[], deps: MainDeps): Promise<number> {
  let noCache = false;
  let budgetOverride: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--no-cache") {
      noCache = true;
    } else if (arg === "--budget") {
      const value = args[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        console.error("evaluador: --budget requires a non-negative integer");
        return EXIT_UNKNOWN_COMMAND;
      }
      budgetOverride = Number(value);
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  const file = positional[0];
  if (file === undefined) {
    console.error("evaluador: eval requires a report file path");
    return EXIT_UNKNOWN_COMMAND;
  }
  try {
    readFileSync(file, "utf8"); // fail fast with the file-specific message
  } catch {
    console.error(`evaluador: cannot read report file: ${file}`);
    return EXIT_UNKNOWN_COMMAND;
  }

  try {
    const result = await runEval({
      reportPath: file,
      noCache,
      budget: budgetOverride ?? loadBudget(deps.cwd ?? process.cwd()),
      driver: deps.driver ?? opencodeDriver(),
      cwd: deps.cwd ?? process.cwd(),
      timeoutMs: deps.timeoutMs,
    });
    if (result.code === EXIT_GATE_FAILED) {
      console.log(
        JSON.stringify({
          ok: false,
          gaps: result.gaps ?? [],
          claims: result.state.claims.length,
        }),
      );
    }
    // runEval's code is the process exit code (0/1, or 3 for an empty roles
    // list, which the CLI cannot currently produce but must map).
    return result.code;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`evaluador: eval failed: ${message}`);
    return EXIT_UNKNOWN_COMMAND;
  }
}

// Reads the per-run budget from `<cwd>/.evaluador/config.json` (created by
// `init` as `{"budget": 20}`). A missing, unreadable or corrupt file — or a
// non-integer/negative value — fails open to DEFAULT_BUDGET: a broken config
// must not silently disable the review or allow an unbounded run.
function loadBudget(cwd: string): number {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(cwd, ".evaluador", "config.json"), "utf8"),
    );
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const value = (raw as Record<string, unknown>).budget;
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
      }
    }
  } catch {
    // Fall through to the default (fail-open, documented above).
  }
  return DEFAULT_BUDGET;
}

function printUsage(): void {
  const lines = [
    "Usage: evaluador <command> [args]",
    "",
    "Commands:",
    "  init   Document the report contract and scaffold .evaluador/ here",
    "  eval <file> [--no-cache] [--budget N]  Run the structural gate and adversarial review",
    "  --help Show this help",
  ];
  console.log(lines.join("\n"));
}

// Parses the argument vector and returns the process exit code.
export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const args = argv.slice();
  const command = args.shift();

  if (command === undefined || command === "--help" || command === "-h") {
    printUsage();
    return EXIT_OK;
  }

  switch (command) {
    case "init":
      return runInit(args);
    case "eval":
      return runEvalCommand(args, deps);
    default:
      console.error(`evaluador: unknown command: ${command}`);
      return EXIT_UNKNOWN_COMMAND;
  }
}

// Resolves the real path, following symlinks (npm bin shims invoke the entry
// through a node_modules/.bin symlink). Returns null when unresolvable.
function tryRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// When invoked as the installed binary, run main and propagate the exit code.
// Both sides are resolved to real paths so a symlinked npm-bin invocation matches.
const entryRealPath = process.argv[1] ? tryRealPath(process.argv[1]) : null;
const moduleRealPath = tryRealPath(fileURLToPath(import.meta.url));
if (entryRealPath !== null && entryRealPath === moduleRealPath) {
  process.exitCode = await main(process.argv.slice(2));
}
