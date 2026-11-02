// Final outputs (Task 11): the four artifacts a completed or paused run leaves
// next to the report — `reporte-final.md`, `reporte-final.html`,
// `evidencia.json` and `resumen.json`.
//
// Content rules honored here:
//   - Human-facing content is Spanish; code and identifiers are English.
//   - Claims keep their own honest label ([VERIFICADO] / [HIPÓTESIS] /
//     [PENDIENTE] / [NO CONCLUYENTE]) and the repo's provenance mark
//     (`**Verificado: YYYY-MM-DD**`). The mark never upgrades a label: a
//     non-VERIFICADO claim, a pending recheck or a blocking verdict is printed
//     as `**No verificado:**` / `**Etiqueta honesta:**` instead.
//   - The attribution chip «Fuente: Gobierno de Canarias» is derived from the
//     claim's own `licencia` (case-insensitive match on "canarias", "gobcan"
//     or "istac", the licence families documented in the Canarias skills); it
//     is never invented when the licence does not ask for attribution.
//   - `resumen.json` uses stable ENGLISH machine keys:
//     {claims, blockers, warnings, openIssues, unverifiedIssues, petitions,
//     spentThisRun, budget, cacheHits, cacheMisses, estado, usoResponsible}.
//     This is the Task 11 carry that renamed the brief's Spanish spellings
//     (bloqueantes → blockers, avisos → warnings, presupuesto → budget,
//     uso_responsable → usoResponsible) so the manifest is stable for machine
//     consumers. `petitions` is the cumulative counter kept in
//     `.evaluador/state.json`; `spentThisRun`/`budget`/`cacheHits`/`cacheMisses`
//     are run-scoped and are `null` when the caller did not pass run stats
//     (honest "not measured", never a fake 0).
//     Issue-level `estado: "cerrada"` is unreachable in v1 by design: closure
//     prunes the issue instead of marking it closed (Task 10), so no renderer
//     fabricates closed issues.
//   - Zero runtime dependencies. HTML is one self-contained string with inline
//     CSS and no imports of any kind (no dataviz, no chart library).
//
// v1 deliberately ships counters + tables only. The source/claim graph is a
// v2 artifact:
// TODO(v2): source graph
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluatorState, RecordedClaim } from "./adversarial.js";
import type { Claim } from "./contract.js";
import type { Issue } from "./issues.js";
import { ROLE_DISPLAY_NAMES } from "./rubric.js";
import type { RoleId } from "./rubric.js";

// Exact artifact names (asserted by the e2e test in Task 12).
export const OUTPUT_FILES = {
  md: "reporte-final.md",
  html: "reporte-final.html",
  evidencia: "evidencia.json",
  resumen: "resumen.json",
} as const;

// Run-scoped accounting supplied by `runEval` (Task 11 carry #3): the state
// only preserves cumulative petitions, so the renderers need a snapshot to
// report cache use for THIS run. `spentThisRun` mirrors the real driver spawns
// (it can be `budget + 1` in the documented retry overshoot), while `budget` is
// the declared cap.
export interface RunStats {
  budget: number;
  spentThisRun: number;
  cacheHits: number;
  cacheMisses: number;
}

// Closure state of the rendered run. Blocking issues win; an aviso-level
// "sin-re-verificar" only leaves the run incomplete; everything else closes.
export type ClosureState = "cerrado" | "abierto" | "incompleto";

// The exact responsible-use declaration required by the spec. The three
// pinned Spanish phrases are part of the resumen.json contract.
const USO_RESPONSABLE = {
  declaracion:
    "Estos portales son un servicio público para toda la ciudadanía: un uso abusivo los degrada para todos.",
  reglas: [
    "presupuesto de peticiones declarado y respetado",
    "espera entre peticiones y respeta robots.txt y límites documentados",
    "cachea localmente lo ya descargado y prefiere API/CSV oficiales al scraping masivo",
  ],
  postura: "ciudadano, no crawler",
} as const;

const ATTRIBUTION_CHIP = "Fuente: Gobierno de Canarias";

// Counts shared by the Markdown and HTML summaries. `blockers`/`warnings` are
// issue severities (Task 10 emits one issue per non-ok verdict, so an issue is
// the authoritative defect), while the verdict counters are shown per claim.
// `petitions` is cumulative across resumed runs; `spentThisRun`/`budget` and
// the cache counters are run-scoped (null when the caller passed no stats).
interface Counts {
  claims: number;
  blockers: number;
  warnings: number;
  openIssues: number;
  unverifiedIssues: number;
  petitions: number;
  spentThisRun: number | null;
  budget: number | null;
  cacheHits: number | null;
  cacheMisses: number | null;
  estado: ClosureState;
}

// ── public renderers ──────────────────────────────────────────────────────

// Human-facing Markdown: state line, counters, claims table, claim detail with
// honest labels + attribution, issue list and the sources summary.
export function renderFinalMd(
  state: EvaluatorState,
  issues: Issue[],
  runStats?: RunStats,
): string {
  const counts = countsFor(state, issues, runStats);
  const date = reviewDate(state);

  const lines: string[] = [
    "# Reporte final — evaluador",
    "",
    `**Estado del cierre:** ${estadoLabel(counts.estado)}`,
    `**Rubric:** ${state.rubricVersion} · **Fecha del estado:** ${date}`,
    "",
    "## Resumen",
    "",
    `- claims: ${counts.claims}`,
    `- bloqueantes: ${counts.blockers}`,
    `- avisos: ${counts.warnings}`,
    `- issues abiertos: ${counts.openIssues}`,
    `- sin re-verificar: ${counts.unverifiedIssues}`,
    "",
    "## Uso de esta ejecución",
    "",
    `- peticiones acumuladas: ${counts.petitions}`,
    `- esta ejecución: ${runSpendText(counts)}`,
    `- cache: ${cacheUseText(counts)}`,
    "",
    "## Afirmaciones",
    "",
  ];

  if (state.claims.length === 0) {
    lines.push("Sin afirmaciones.", "");
  } else {
    lines.push(
      "| # | Claim | Etiqueta | Cifra | Fuente | Veredictos |",
      "|---|---|---|---|---|---|",
    );
    state.claims.forEach((recorded, index) => {
      const verdicts = verdictCounts(recorded);
      lines.push(
        `| ${index + 1} | ${mdCell(recorded.claim.id)} | ${mdCell(
          `[${recorded.claim.etiqueta}]`,
        )} | ${mdCell(recorded.claim.cifra ?? "—")} | ${mdCell(
          recorded.claim.fuente,
        )} | ${mdCell(verdictCell(verdicts))} |`,
      );
    });
    lines.push("");
  }

  lines.push("## Detalle de afirmaciones", "");
  if (state.claims.length === 0) {
    lines.push("Sin afirmaciones.", "");
  } else {
    for (const recorded of state.claims) {
      lines.push(...claimBlock(recorded, date));
    }
  }

  lines.push("## Problemas", "");
  if (issues.length === 0) {
    lines.push("Sin problemas detectados.", "");
  } else {
    for (const issue of issues) {
      lines.push(...issueBlock(issue));
    }
  }

  lines.push("## Fuentes", "");
  const sources = sourceGroups(state);
  if (sources.length === 0) {
    lines.push("Sin fuentes declaradas.", "");
  } else {
    for (const source of sources) {
      lines.push(
        `- **${mdCell(source.fuente)}** — ${mdCell(source.url)} — ${
          source.claims.length
        } afirmación(es): ${source.claims.map((id) => `\`${mdCell(id)}\``).join(", ")}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Uso responsable",
    "",
    USO_RESPONSABLE.declaracion,
    "",
    ...USO_RESPONSABLE.reglas.map((rule) => `- ${rule}`),
    "",
    "El presupuesto cuenta llamadas a los agentes revisores (driver calls), no peticiones a portales.",
    "",
    `**Revisión:** ${date} — ${state.rubricVersion}; ${counts.claims} afirmación(es), ${
      issues.length
    } issue(s), ${counts.blockers} bloqueante(s).`,
    "",
  );

  return lines.join("\n");
}

// Single-file HTML: counters + claims table + issues + sources. Inline CSS,
// no external imports, no scripts and no chart/graph library.
export function renderHtml(
  state: EvaluatorState,
  issues: Issue[],
  runStats?: RunStats,
): string {
  const counts = countsFor(state, issues, runStats);
  const date = reviewDate(state);

  const claimRows = state.claims
    .map((recorded, index) => {
      const chip = attributionFor(recorded.claim);
      const verdicts = verdictCounts(recorded);
      return `<tr>
  <td>${index + 1}</td>
  <td><code>${esc(recorded.claim.id)}</code></td>
  <td><span class="label">[${esc(recorded.claim.etiqueta)}]</span></td>
  <td>${esc(recorded.claim.afirmacion)}</td>
  <td>${esc(recorded.claim.cifra ?? "—")}</td>
  <td>${esc(recorded.claim.fuente)}</td>
  <td>${esc(verdictCell(verdicts))}</td>
  <td>${chip === null ? "—" : `<span class="chip">${esc(chip)}</span>`}</td>
</tr>`;
    })
    .join("\n");

  const issueRows = issues
    .map(
      (issue) => `<tr>
  <td><code>${esc(issue.id)}</code></td>
  <td><span class="severity ${esc(issue.severity)}">${esc(issue.severity)}</span></td>
  <td>${esc(issue.claimId ?? "—")}</td>
  <td>${esc(roleName(issue.role))}</td>
  <td>${esc(issue.rubricItem)}</td>
  <td>${esc(issue.hallazgo)}</td>
  <td>${esc(issue.propuesta)}</td>
  <td>${esc(issue.estado)}</td>
</tr>`,
    )
    .join("\n");

  const sourceItems = sourceGroups(state)
    .map((source) => {
      // Claim URLs are report data, not trusted markup: only http(s) becomes a
      // link; any other scheme is shown as inert text.
      const href = safeHref(source.url);
      const link =
        href === null
          ? `<code>${esc(source.url)}</code>`
          : `<a href="${esc(href)}">${esc(source.url)}</a>`;
      return `<li><strong>${esc(source.fuente)}</strong> — ${link} <span class="count">(${
        source.claims.length
      } afirmación(es))</span></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reporte final — evaluador</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 72rem; padding: 1.5rem; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.45; }
h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
h2 { margin: 2rem 0 .75rem; font-size: 1.15rem; border-bottom: 1px solid #8884; padding-bottom: .25rem; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { border: 1px solid #8884; padding: .4rem .5rem; text-align: left; vertical-align: top; }
th { background: #8881; }
code { font-size: .85em; }
.chip { display: inline-block; padding: .1rem .45rem; border-radius: 999px; background: #2b6cb022; border: 1px solid #2b6cb066; white-space: nowrap; }
.label { font-weight: 600; white-space: nowrap; }
.severity.bloqueante { color: #b00020; font-weight: 700; }
.severity.aviso { color: #8a6100; font-weight: 600; }
.estado { font-weight: 600; }
.estado.abierto { color: #b00020; }
.estado.incompleto { color: #8a6100; }
.estado.cerrado { color: #1b6e2d; }
.counters { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; padding: 0; list-style: none; }
.sources { padding-left: 1.1rem; }
.count, .meta { color: #666; font-size: .9rem; }
.empty { color: #666; font-style: italic; }
footer { margin-top: 2.5rem; border-top: 1px solid #8884; padding-top: .75rem; }
</style>
</head>
<body>
<header>
<h1>Reporte final — evaluador</h1>
<p class="estado ${counts.estado}">Estado del cierre: ${estadoLabel(
    counts.estado,
  )}</p>
<p class="meta">Rubric ${esc(state.rubricVersion)} · fecha del estado ${esc(
    date,
  )} · peticiones acumuladas ${counts.petitions}</p>
</header>
<section>
<h2>Contadores</h2>
<ul class="counters">
<li><strong>claims:</strong> ${counts.claims}</li>
<li><strong>bloqueantes:</strong> ${counts.blockers}</li>
<li><strong>avisos:</strong> ${counts.warnings}</li>
<li><strong>issues abiertos:</strong> ${counts.openIssues}</li>
<li><strong>sin re-verificar:</strong> ${counts.unverifiedIssues}</li>
</ul>
</section>
<section>
<h2>Uso de esta ejecución</h2>
<ul class="counters">
<li><strong>peticiones acumuladas:</strong> ${counts.petitions}</li>
<li><strong>esta ejecución:</strong> ${esc(runSpendText(counts))}</li>
<li><strong>cache:</strong> ${esc(cacheUseText(counts))}</li>
</ul>
</section>
<section>
<h2>Afirmaciones</h2>
${
  state.claims.length === 0
    ? '<p class="empty">Sin afirmaciones.</p>'
    : `<table>
<thead><tr><th>#</th><th>Claim</th><th>Etiqueta</th><th>Afirmación</th><th>Cifra</th><th>Fuente</th><th>Veredictos</th><th>Atribución</th></tr></thead>
<tbody>
${claimRows}
</tbody>
</table>`
}
</section>
<section>
<h2>Problemas</h2>
${
  issues.length === 0
    ? '<p class="empty">Sin problemas detectados.</p>'
    : `<table>
<thead><tr><th>Issue</th><th>Severidad</th><th>Claim</th><th>Rol</th><th>Rubric</th><th>Hallazgo</th><th>Propuesta</th><th>Estado</th></tr></thead>
<tbody>
${issueRows}
</tbody>
</table>`
}
</section>
<section>
<h2>Fuentes</h2>
${
  sourceItems === ""
    ? '<p class="empty">Sin fuentes declaradas.</p>'
    : `<ul class="sources">
${sourceItems}
</ul>`
}
</section>
<footer>
<h2>Uso responsable</h2>
<p>${esc(USO_RESPONSABLE.declaracion)}</p>
<ul>${USO_RESPONSABLE.reglas.map((rule) => `<li>${esc(rule)}</li>`).join("")}</ul>
<p class="meta">El presupuesto cuenta llamadas a los agentes revisores (driver calls), no peticiones a portales.</p>
<p class="meta">Revisión ${esc(date)} — ${esc(state.rubricVersion)}; ${
    counts.claims
  } afirmación(es), ${issues.length} issue(s), ${counts.blockers} bloqueante(s).</p>
</footer>
</body>
</html>
`;
}

// Machine-consumable evidence: every claim field verbatim (url included),
// plus its content hash, the declared recheck marker and all its verdicts.
export function renderEvidenciaJson(state: EvaluatorState): string {
  const payload = {
    version: state.version,
    reporte: state.reporte,
    rubricVersion: state.rubricVersion,
    updatedAt: state.updatedAt,
    petitions: state.petitions,
    ...(state.roles === undefined ? {} : { roles: [...state.roles] }),
    claims: state.claims.map((recorded) => ({
      ...recorded.claim,
      hash: recorded.hash,
      ...(recorded.recheck === undefined ? {} : { recheck: recorded.recheck }),
      // Copy the evidence array so the JSON cannot alias state by accident.
      verdicts: recorded.verdicts.map((verdict) => ({
        ...verdict,
        evidencia: [...verdict.evidencia],
      })),
    })),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

// Machine-consumable run summary. Keys are pinned in English (see header).
export function renderResumen(
  state: EvaluatorState,
  issues: Issue[],
  runStats?: RunStats,
): string {
  const counts = countsFor(state, issues, runStats);
  const summary = {
    claims: counts.claims,
    blockers: counts.blockers,
    warnings: counts.warnings,
    openIssues: counts.openIssues,
    unverifiedIssues: counts.unverifiedIssues,
    petitions: counts.petitions,
    spentThisRun: counts.spentThisRun,
    budget: counts.budget,
    cacheHits: counts.cacheHits,
    cacheMisses: counts.cacheMisses,
    estado: counts.estado,
    usoResponsible: USO_RESPONSABLE,
  };
  return JSON.stringify(summary, null, 2) + "\n";
}

// Writes the four artifacts into `dir` (mkdir -p) and returns the written
// paths. The directory is resolved by the caller (runEval: `-o` or the
// report's own directory).
export function writeOutputs(
  dir: string,
  state: EvaluatorState,
  issues: Issue[],
  runStats?: RunStats,
): string[] {
  mkdirSync(dir, { recursive: true });
  const outputs: Array<readonly [string, string]> = [
    [OUTPUT_FILES.md, renderFinalMd(state, issues, runStats)],
    [OUTPUT_FILES.html, renderHtml(state, issues, runStats)],
    [OUTPUT_FILES.evidencia, renderEvidenciaJson(state)],
    [OUTPUT_FILES.resumen, renderResumen(state, issues, runStats)],
  ];
  const written: string[] = [];
  for (const [name, content] of outputs) {
    const path = join(dir, name);
    writeFileSync(path, content);
    written.push(path);
  }
  return written;
}

// ── shared helpers ────────────────────────────────────────────────────────

function countsFor(
  state: EvaluatorState,
  issues: Issue[],
  runStats: RunStats | undefined,
): Counts {
  return {
    claims: state.claims.length,
    blockers: issues.filter((issue) => issue.severity === "bloqueante").length,
    warnings: issues.filter((issue) => issue.severity === "aviso").length,
    openIssues: issues.filter((issue) => issue.estado === "abierta").length,
    unverifiedIssues: issues.filter(
      (issue) => issue.estado === "sin-re-verificar",
    ).length,
    petitions: state.petitions,
    spentThisRun: runStats?.spentThisRun ?? null,
    budget: runStats?.budget ?? null,
    cacheHits: runStats?.cacheHits ?? null,
    cacheMisses: runStats?.cacheMisses ?? null,
    estado: closureState(issues),
  };
}

// Run-scoped spend as one deterministic label; "no medida" is the honest
// fallback when a caller renders state without a run snapshot.
function runSpendText(counts: Counts): string {
  if (counts.spentThisRun === null || counts.budget === null) return "no medida";
  return `${counts.spentThisRun} de budget ${counts.budget}`;
}

function cacheUseText(counts: Counts): string {
  if (counts.cacheHits === null || counts.cacheMisses === null) return "no medido";
  return `${counts.cacheHits} hit(s) / ${counts.cacheMisses} miss(es)`;
}

function closureState(issues: Issue[]): ClosureState {
  if (issues.some((issue) => issue.severity === "bloqueante")) {
    return "abierto";
  }
  if (issues.some((issue) => issue.estado === "sin-re-verificar")) {
    return "incompleto";
  }
  return "cerrado";
}

function estadoLabel(estado: ClosureState): string {
  switch (estado) {
    case "abierto":
      return "abierto — hay problemas bloqueantes: el cierre no se puede firmar.";
    case "incompleto":
      return "incompleto — hay revisiones sin re-verificar.";
    default:
      return "cerrado — sin bloqueantes; los avisos no impiden el cierre.";
  }
}

// The `licencia` field is the only attribution signal the contract carries.
// Matching is case-insensitive and scoped to Canarias public bodies: the repo's
// two documented licence families (`gobcan-aviso-legal`, `istac-aviso-legal`)
// and any explicit "Canarias" mention require the chip; another public body's
// licence (e.g. "Gobierno de España") must NOT inherit it.
const CANARIAS_LICENCE = /canarias|gobcan|istac/i;

function attributionFor(claim: Claim): string | null {
  return CANARIAS_LICENCE.test(claim.licencia ?? "") ? ATTRIBUTION_CHIP : null;
}

interface VerdictCounts {
  total: number;
  blocking: number;
  warnings: number;
}

function verdictCounts(recorded: RecordedClaim): VerdictCounts {
  // An `ok` verdict still carries a severidad by contract; only non-ok verbs
  // are actual findings, so the claim's "bloqueante(s) / aviso(s)" counters
  // must not inflate a clean claim with three phantom avisos.
  const findings = recorded.verdicts.filter(
    (verdict) => verdict.resultado !== "ok",
  );
  return {
    total: recorded.verdicts.length,
    blocking: findings.filter((verdict) => verdict.severidad === "bloqueante")
      .length,
    warnings: findings.filter((verdict) => verdict.severidad === "aviso")
      .length,
  };
}

function verdictCell(counts: VerdictCounts): string {
  if (counts.total === 0) return "sin veredictos";
  return `${counts.total} (${counts.blocking} bloqueante(s), ${counts.warnings} aviso(s))`;
}

// Detail block for one claim. The provenance mark is deliberately conditional:
// only a VERIFICADO claim with a complete, blocker-free review may read as
// `**Verificado:**`; everything else states its honest gap.
function claimBlock(recorded: RecordedClaim, date: string): string[] {
  const { claim } = recorded;
  const counts = verdictCounts(recorded);
  const chip = attributionFor(claim);
  const lines: string[] = [
    `### ${oneLine(claim.id)} — [${claim.etiqueta}]`,
    "",
    `- **Afirmación:** ${oneLine(claim.afirmacion)}`,
  ];
  if (claim.cifra !== undefined) {
    lines.push(`- **Cifra:** ${oneLine(claim.cifra)}`);
  }
  lines.push(
    `- **Fuente:** ${oneLine(claim.fuente)} — ${oneLine(claim.url)}`,
    `- **Fecha del dato:** ${claim.fecha_dato} · **Fecha de consulta:** ${claim.fecha_consulta}`,
    `- **Criterio:** ${oneLine(claim.criterio)}`,
  );
  if (claim.filas_traidas !== undefined && claim.conteo_declarado !== undefined) {
    lines.push(
      `- **Filas:** ${claim.filas_traidas} traídas vs ${claim.conteo_declarado} declaradas`,
    );
  }
  lines.push(
    `- **Banderas:** ${
      claim.banderas.length === 0
        ? "ninguna"
        : claim.banderas.map(oneLine).join("; ")
    }`,
    `- **Dedup:** ${claim.dedup ? "sí" : "no"}`,
  );
  if (claim.licencia !== undefined) {
    lines.push(`- **Licencia:** ${oneLine(claim.licencia)}`);
  }
  if (chip !== null) {
    lines.push(`- **Atribución:** ${chip}`);
  }
  lines.push(`- **Veredictos:** ${verdictCell(counts)}`);
  if (recorded.recheck !== undefined) {
    lines.push(
      `- **No verificado:** hueco declarado (${recorded.recheck}) — la revisión no está completa.`,
    );
  } else if (claim.etiqueta !== "VERIFICADO") {
    lines.push(
      `- **Etiqueta honesta:** [${claim.etiqueta}] — no se presenta como verificado.`,
    );
  } else if (counts.blocking > 0) {
    lines.push(
      `- **No verificado:** ${counts.blocking} veredicto(s) bloqueante(s) — no se puede presentar como verificado.`,
    );
  } else {
    lines.push(
      `- **Verificado:** ${date} — ${counts.total} veredicto(s) adversarial(es), sin bloqueantes.`,
    );
  }
  lines.push("");
  return lines;
}

function issueBlock(issue: Issue): string[] {
  return [
    `### ${issue.id} · ${issue.severity} · ${issue.estado}`,
    "",
    `- **Claim:** ${issue.claimId === undefined ? "—" : issue.claimId}`,
    `- **Rol:** ${roleName(issue.role)}`,
    `- **Rubric:** ${oneLine(issue.rubricItem)}`,
    `- **Hallazgo:** ${oneLine(issue.hallazgo)}`,
    `- **Propuesta:** ${oneLine(issue.propuesta)}`,
    "",
  ];
}

interface SourceGroup {
  fuente: string;
  url: string;
  claims: string[];
}

// Distinct (fuente, url) pairs in claim order, with the claims that cite each.
// Attribution stays with the individual claim: a group-level chip would imply
// a licence for claims that never declared one.
function sourceGroups(state: EvaluatorState): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const { claim } of state.claims) {
    const key = `${claim.fuente}\u0000${claim.url}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        fuente: claim.fuente,
        url: claim.url,
        claims: [claim.id],
      });
      continue;
    }
    existing.claims.push(claim.id);
  }
  return [...groups.values()];
}

// Role ids are ASCII; the presentation name carries the accent (Task 6).
function roleName(role: string): string {
  return ROLE_DISPLAY_NAMES[role as RoleId] ?? role;
}

function reviewDate(state: EvaluatorState): string {
  const date = state.updatedAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : state.updatedAt;
}

// Markdown table cells must stay one line and may not break the table.
function mdCell(value: string): string {
  return oneLine(value).replace(/\|/g, "\\|");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Returns the URL only when it is an http(s) URL; every other scheme (and any
// unparseable token) stays inert text in the generated HTML.
function safeHref(value: string): string | null {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

// HTML escaping for every dynamic value (claim text, URLs, issue fields).
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
