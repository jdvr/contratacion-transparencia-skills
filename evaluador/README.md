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
node dist/cli.js eval reporte.md [-o salida] [--no-cache] [--budget 20] [--roles contadores,segunda-fuente] [--model provider/model] [--git-branches]
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
