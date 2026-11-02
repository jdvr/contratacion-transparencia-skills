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
node dist/cli.js eval reporte.md [-o salida] [--no-cache] [--budget 20] [--git-branches]
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Closed: no blocking verdicts, no declared gaps, every label honest. |
| `1` | Finished with blocking findings or declared gaps (issues written). |
| `2` | Structural gate failed: machine-readable gaps on stdout, no state written. |
| `3` | Usage error (bad flags, missing/unreadable report, empty roles). |

## Build and host

`npm run build` bundles everything into `dist/cli.js`: one self-contained ESM
file with a Node shebang and no runtime dependencies. Build once with
`npm ci && npm run build`, then copy `dist/cli.js` anywhere on an agent host
(or `npm link` inside `evaluador/` to expose the `evaluador` binary) and run it
with Node 22+. The real driver shells out to the `opencode` binary; tests and
embedded runs inject a fake driver and never touch the network.

See `../docs/superpowers/specs/2026-10-31-evaluador-design.md` for the design.
