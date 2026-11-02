# evaluador

Adversarial-review closure harness for evidence-contract reports. It runs a
deterministic structural gate over a Markdown report whose claims are fenced
`json` blocks, then asks four independent reviewers (counters, second source,
falsifier, methodical) to attack every claim. Each finding becomes an issue
artifact, and a completed or paused run leaves the final report next to the
source. The harness never invents figures: claims, sources and citations are
the report author's.

All fixtures in this directory are **generated data**; do not put real company
data (NIF, awards, amounts) in tests.

**Never commit material produced from a real report.** Generated outputs
(`reporte-final.md`, `reporte-final.html`, `evidencia.json`, `resumen.json`,
and the whole `.evaluador/` working directory) can carry personal or company
data from the sources you reviewed. They belong in your working directories,
not in this public repository; the root `.gitignore` already excludes
`.evaluador/`.

## Adversarial roles — see ROLES.md for the role-by-role reference (Spanish)

`ROLES.md` documents the four reviewers (counters, second source, falsifier,
methodical): the checklist each one owns, the verdict each one owes, the
`--roles` subset semantics and its interactions with budget, cache and issues.
It is the readable summary of the prompts versioned in `src/rubric.ts`.

## Commands

```bash
cd evaluador
npm ci
npm run build

# Print the report contract and scaffold .evaluador/ in the current directory:
node dist/cli.js init

# Gate + adversarial review. Writes .evaluador/state.json, .evaluador/issues/,
# and reporte-final.md/.html + evidencia.json + resumen.json next to the report
# (or under -o <dir>):
node dist/cli.js eval reporte.md [-o salida] [--no-cache] [--budget 20] [--roles contadores,segunda-fuente] [--model provider/model] [--timeout 300] [--jobs 4] [--git-branches]
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Closed: no blocking verdicts, no declared gaps, every label honest. |
| `1` | Finished with blocking findings or declared gaps (issues written). |
| `2` | Structural gate failed: machine-readable gaps on stdout, no state written. |
| `3` | Usage error (bad flags, missing/unreadable report, empty roles). |

The `--budget` counter tracks calls to the reviewer agents (driver calls), not
HTTP requests to public portals; `resumen.json` reports the cumulative count
(`petitions`) separately from this run's spend (`spentThisRun`).

`--model provider/model` is passed verbatim to `opencode run` and applies to all
reviewer roles in that run; without the flag, opencode's default model is used.
The reviewer model is part of the cache key: changing `--model` re-reviews
claims (or pass `--no-cache` to force a full re-run).

Progress goes to **stderr** (stdout stays reserved for the gate-failure JSON):
one line per claim×role pair, cache/state reuse, and a heartbeat every 30 s
while a call is in flight. The default per-call timeout is 300 s; override it
with `--timeout <seconds>`. A call that hits the timeout is recorded honestly as
`sin-re-verificar`/`bloqueante` (exit 1), never as a silent hang. Slow free
models can legitimately spend minutes on one claim — watch the heartbeat, and
prefer a fast model for long reports (e.g. `--model opencode-go/deepseek-v4.1-flash`
worked reliably for this repo). A backend that traps `SIGTERM` is escalated to
`SIGKILL` after a 5 s grace, so an aborted run leaves no orphan subprocess.

`--jobs N` runs up to N claim×role pairs concurrently (CLI default **4**;
`--jobs 1` is the sequential mode). The pool is over all pairs, so a slow role
does not block the other claims; state, issues and branches still materialize in
claim→role order. The budget is a **soft cap**: no new pair is launched once
`spent >= budget`, but pairs already in flight finish, so the real spend can
exceed the budget by up to `jobs-1` calls (plus one retry per in-flight call, as
in the sequential mode). `spentThisRun` and `petitions` record the real calls.
Four concurrent clients can hit provider rate limits on free models; use
`--jobs 2` if that happens.

## Build and host

`npm run build` bundles everything into `dist/cli.js`: one self-contained ESM
file with a Node shebang and no runtime dependencies. Build once with
`npm ci && npm run build`, then copy `dist/cli.js` anywhere on an agent host
(or `npm link` inside `evaluador/` to expose the `evaluador` binary) and run it
with Node 22+. The real driver shells out to the `opencode` binary; tests and
embedded runs inject a fake driver and never touch the network.

The fetch allowlist is **prompt-enforced in v1**: the driver tells the model
which URLs it may fetch (after `www.` normalization and the documented
`*.gobiernodecanarias.org` wildcard), but there is no OS-level network
restriction — the model decides, and an unlisted source must be declared
`sin-re-verificar` instead of fetched.

See `../docs/superpowers/specs/2026-10-31-evaluador-design.md` for the design.
