// evaluador CLI entry point.
// Exit codes: 0 = success, 3 = unknown (or not yet wired) command.
// See docs/superpowers/specs/2026-10-31-evaluador-design.md.
import { pathToFileURL } from "node:url";

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

// When invoked as the installed binary, run main and propagate the exit code.
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryHref === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
