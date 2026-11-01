// evaluador CLI entry point.
// Exit codes: 0 = success, 3 = unknown (or not yet wired) command.
// See docs/superpowers/specs/2026-10-31-evaluador-design.md.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_UNKNOWN_COMMAND = 3;

// Placeholder delegation targets; Tasks 2+ replace these with real implementations.
async function runInit(_args: string[]): Promise<number> {
  return EXIT_UNKNOWN_COMMAND;
}

async function runEval(_args: string[]): Promise<number> {
  return EXIT_UNKNOWN_COMMAND;
}

function printUsage(): void {
  const lines = [
    "Usage: evaluador <command> [args]",
    "",
    "Commands:",
    "  init   Set up the closing workflow (not yet wired)",
    "  eval   Run the adversarial-review closure (not yet wired)",
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
