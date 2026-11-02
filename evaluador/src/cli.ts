// evaluador CLI entry point.
// Exit codes: 0 = success, 2 = structural gate failed, 3 = unknown (or not yet
// wired) command.
// See docs/superpowers/specs/2026-10-31-evaluador-design.md.
import { realpathSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runGate } from "./gate.js";
import { initScripted } from "./init.js";

const EXIT_OK = 0;
const EXIT_UNKNOWN_COMMAND = 3;
const EXIT_GATE_FAILED = 2;

// Placeholder delegation targets; Tasks 5+ replace these with real implementations.
// init: prints the report contract (INIT_CONTRACT) and scaffolds .evaluador/
// in the process cwd. stdout is written directly: initScripted's chunks carry
// their own trailing newlines (no printUsage/console.log double-spacing).
async function runInit(_args: string[]): Promise<number> {
  return initScripted(process.cwd(), (s) => process.stdout.write(s));
}

// eval <file>: runs the deterministic structural gate on the report. A failed
// gate exits 2 with the machine-readable gaps JSON on stdout (repeatable until
// the report passes). A passed gate is temporarily exit 0 with the gate result
// JSON: phases 2+ (Task 8's runEval) will refine 0/1 from there.
async function runEval(args: string[]): Promise<number> {
  const file = args.shift();
  if (file === undefined) {
    console.error("evaluador: eval requires a report file path");
    return EXIT_UNKNOWN_COMMAND;
  }
  let markdown: string;
  try {
    markdown = readFileSync(file, "utf8");
  } catch {
    console.error(`evaluador: cannot read report file: ${file}`);
    return EXIT_UNKNOWN_COMMAND;
  }
  const { ok, gaps, claims } = runGate(markdown);
  console.log(JSON.stringify({ ok, gaps, claims: claims.length }));
  return ok ? EXIT_OK : EXIT_GATE_FAILED;
}

function printUsage(): void {
  const lines = [
    "Usage: evaluador <command> [args]",
    "",
    "Commands:",
    "  init   Document the report contract and scaffold .evaluador/ here",
    "  eval   Run the structural gate on a report (later phases pending)",
    "  --help Show this help",
  ];
  console.log(lines.join("\n"));
}

// Parses the argument vector and returns the process exit code.
export async function main(argv: string[]): Promise<number> {
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
      return runEval(args);
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
