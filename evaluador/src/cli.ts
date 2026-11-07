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
import { HELP_EVAL, HELP_GENERAL, HELP_INIT, initScripted } from "./init.js";
import { DEFAULT_ROLES, ROLE_ALIASES } from "./rubric.js";
import type { RoleId } from "./rubric.js";

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
  // Concurrent claim×role workers for the CLI default (flag wins).
  jobs?: number;
  // Progress sink. The installed binary passes console.error so stderr shows
  // per-call progress; tests and embedded callers stay silent by default.
  logger?: (line: string) => void;
}

// init: prints the report contract (INIT_CONTRACT) and scaffolds .evaluador/
// in the process cwd. stdout is written directly: initScripted's chunks carry
// their own trailing newlines (no printUsage/console.log double-spacing).
async function runInit(_args: string[]): Promise<number> {
  return initScripted(process.cwd(), (s) => process.stdout.write(s));
}

// Parsed `eval` arguments. Kept separate from the command so the strict parsing
// rules (unknown flags, flag-value guards, positional count) are unit-testable
// without touching the filesystem or a driver.
export interface EvalArgs {
  file: string;
  outDir?: string;
  noCache: boolean;
  gitBranches: boolean;
  budget?: number;
  roles?: RoleId[];
  // Reviewer model passed verbatim to the backend (`provider/model`).
  model?: string;
  // Per-call driver timeout from `--timeout <seconds>`.
  timeoutMs?: number;
  // Concurrent review workers (`--jobs`); the CLI default is 4.
  jobs?: number;
}

export type EvalArgsResult =
  | { ok: true; args: EvalArgs }
  | { ok: false; message: string };

// Resolves a CLI role name to its RoleId: the ASCII id itself or a short alias
// (contador → contadores, segunda → segunda-fuente).
function resolveRole(name: string): RoleId | undefined {
  const alias = ROLE_ALIASES[name];
  if (alias !== undefined) return alias;
  return (DEFAULT_ROLES as readonly string[]).includes(name)
    ? (name as RoleId)
    : undefined;
}

// Strict `eval` parser. Fail-closed rules (all exit 3 at the CLI):
//   - any unknown token starting with "-" is a flag typo, never a file;
//   - -o/--budget/--roles/--model reject a missing value or one that starts
//     with "-";
//   - exactly one positional (the report path) is accepted;
//   - --roles is a comma list resolved through ROLE_ALIASES, all names valid.
export function parseEvalArgs(argv: string[]): EvalArgsResult {
  let noCache = false;
  let gitBranches = false;
  let budget: number | undefined;
  let outDir: string | undefined;
  let roles: RoleId[] | undefined;
  let model: string | undefined;
  let timeoutMs: number | undefined;
  let jobs: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--no-cache":
        noCache = true;
        break;
      case "--git-branches":
        gitBranches = true;
        break;
      case "-o": {
        const value = argv[i + 1];
        if (value === undefined || value === "" || value.startsWith("-")) {
          return { ok: false, message: "-o requires an output directory" };
        }
        outDir = value;
        i += 1;
        break;
      }
      case "--budget": {
        const value = argv[i + 1];
        if (value === undefined || !/^\d+$/.test(value)) {
          return {
            ok: false,
            message: "--budget requires a non-negative integer",
          };
        }
        budget = Number(value);
        i += 1;
        break;
      }
      case "--roles": {
        const value = argv[i + 1];
        if (value === undefined || value === "" || value.startsWith("-")) {
          return {
            ok: false,
            message: "--roles requires a comma-separated role list",
          };
        }
        const resolved: RoleId[] = [];
        for (const raw of value.split(",")) {
          const name = raw.trim();
          const role = resolveRole(name);
          if (role === undefined) {
            return { ok: false, message: `unknown role: ${name}` };
          }
          if (!resolved.includes(role)) resolved.push(role);
        }
        roles = resolved;
        i += 1;
        break;
      }
      case "--model": {
        const value = argv[i + 1];
        // No format validation beyond this guard: `provider/model` is opencode's
        // convention, not the harness's, so the value passes through verbatim.
        if (value === undefined || value === "" || value.startsWith("-")) {
          return { ok: false, message: "--model requires a provider/model value" };
        }
        model = value;
        i += 1;
        break;
      }
      case "--timeout": {
        const value = argv[i + 1];
        if (value === undefined || !/^[1-9]\d*$/.test(value)) {
          return {
            ok: false,
            message: "--timeout requires a positive integer of seconds",
          };
        }
        timeoutMs = Number(value) * 1000;
        i += 1;
        break;
      }
      case "--jobs": {
        const value = argv[i + 1];
        if (value === undefined || !/^[1-9]\d*$/.test(value)) {
          return { ok: false, message: "--jobs requires a positive integer" };
        }
        jobs = Number(value);
        i += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          return { ok: false, message: `unknown flag: ${arg}` };
        }
        positional.push(arg);
    }
  }

  const file = positional[0];
  if (file === undefined) {
    return { ok: false, message: "eval requires a report file path" };
  }
  if (positional.length > 1) {
    return {
      ok: false,
      message: `unexpected extra argument: ${positional[1]}`,
    };
  }
  return {
    ok: true,
    args: { file, outDir, noCache, gitBranches, budget, roles, model, timeoutMs, jobs },
  };
}

// eval <file> [-o <dir>] [--no-cache] [--budget N] [--roles a,b]
// [--model provider/model] [--git-branches]: runs the structural gate and, when
// it passes, the adversarial phases via runEval. The process exit code is
// runEval's own (0/1), gate failure stays 2 (gaps JSON on stdout for the invoking
// model), and an unreadable report or a malformed flag is a usage error (3).
// Issue artifacts are written by runEval (Task 10); the four final outputs
// (Task 11) land in `-o <dir>` or next to the report; `--git-branches` (off by
// default in v1) additionally creates `problema/<claimId>` for blocking
// verdicts, with git failures degraded to warnings. stdout stays reserved for
// the JSON status of a gate failure. `--model` applies to every reviewer role of
// the run and is forwarded verbatim to `opencode run`.
async function runEvalCommand(args: string[], deps: MainDeps): Promise<number> {
  const parsed = parseEvalArgs(args);
  if (!parsed.ok) {
    console.error(`evaluador: ${parsed.message}`);
    return EXIT_UNKNOWN_COMMAND;
  }
  const { file, outDir, noCache, gitBranches, budget, roles, model, timeoutMs, jobs } =
    parsed.args;

  try {
    readFileSync(file, "utf8"); // fail fast with the file-specific message
  } catch {
    console.error(`evaluador: cannot read report file: ${file}`);
    return EXIT_UNKNOWN_COMMAND;
  }

  const config = loadConfig(deps.cwd ?? process.cwd());

  try {
    const result = await runEval({
      reportPath: file,
      outDir,
      noCache,
      roles,
      model,
      budget: budget ?? config.budget,
      allowHosts: config.allowHosts,
      driver: deps.driver ?? opencodeDriver(),
      cwd: deps.cwd ?? process.cwd(),
      // The flag wins over the test seam, so an embedded caller can still cap
      // the default while the CLI exposes per-run control.
      timeoutMs: timeoutMs ?? deps.timeoutMs,
      jobs: jobs ?? deps.jobs ?? 4,
      logger: deps.logger,
      gitBranches,
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

// Reads the per-run settings from `<cwd>/.evaluador/config.json` (created by
// `init` as `{"budget": 20}`). `budget` is the request cap for this run;
// `allowHosts` is the human's decision to extend the fetch allowlist (exact
// hosts, no wildcards). A missing, unreadable or corrupt file — or an invalid
// value — fails open to the defaults: a broken config must not silently disable
// the review, allow an unbounded run, or widen the allowlist by accident.
function loadConfig(cwd: string): { budget: number; allowHosts: string[] } {
  const fallback = { budget: DEFAULT_BUDGET, allowHosts: [] as string[] };
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(cwd, ".evaluador", "config.json"), "utf8"),
    );
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return fallback;
    }
    const record = raw as Record<string, unknown>;
    const budget =
      typeof record.budget === "number" &&
      Number.isInteger(record.budget) &&
      record.budget >= 0
        ? record.budget
        : DEFAULT_BUDGET;
    const allowHosts = Array.isArray(record.allowHosts)
      ? record.allowHosts.filter(
          (host): host is string => typeof host === "string" && host.trim() !== "",
        )
      : [];
    return { budget, allowHosts };
  } catch {
    // Fall through to the defaults (fail-open, documented above).
    return fallback;
  }
}

// `help` / `--help` / bare invocation. One source for both the terminal and
// the `.evaluador/CONTRATO.md` that `init` leaves behind (init.ts).
function printHelp(topic: string | undefined): number {
  if (topic === undefined) {
    console.log(HELP_GENERAL);
    return EXIT_OK;
  }
  if (topic === "eval") {
    console.log(HELP_EVAL);
    return EXIT_OK;
  }
  if (topic === "init") {
    console.log(HELP_INIT);
    return EXIT_OK;
  }
  console.error(`evaluador: unknown help topic: ${topic}`);
  return EXIT_UNKNOWN_COMMAND;
}

// Parses the argument vector and returns the process exit code. The top-level
// try/catch is the IO containment net (final-review fix): an unexpected throw
// (e.g. EACCES while `init` scaffolds .evaluador/) becomes a clear stderr line
// and exit 3, never an unhandled rejection with Node's own exit code.
export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const args = argv.slice();
  const command = args.shift();

  try {
    if (command === undefined || command === "--help" || command === "-h") {
      return printHelp(args[0]);
    }

    switch (command) {
      case "help":
        return printHelp(args[0]);
      case "init":
        return await runInit(args);
      case "eval":
        return await runEvalCommand(args, deps);
      default:
        console.error(`evaluador: unknown command: ${command}`);
        return EXIT_UNKNOWN_COMMAND;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`evaluador: ${message}`);
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
// The outer try/catch is a second containment ring: main already maps expected
// I/O failures to exit 3, and anything that escapes still becomes a clear
// stderr line plus exit 3 (never Node's own unhandled-rejection exit code).
const entryRealPath = process.argv[1] ? tryRealPath(process.argv[1]) : null;
const moduleRealPath = tryRealPath(fileURLToPath(import.meta.url));
if (entryRealPath !== null && entryRealPath === moduleRealPath) {
  try {
    process.exitCode = await main(process.argv.slice(2), {
      // Progress is best-effort and goes to stderr, so stdout stays reserved
      // for the gate-failure JSON and pipelines can consume it unchanged.
      logger: (line) => console.error(line),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`evaluador: ${message}`);
    process.exitCode = EXIT_UNKNOWN_COMMAND;
  }
}
