// Deterministic structural gate over the report contract (Task 3). The parser
// (Task 2) is deliberately tolerant; this gate is the strict layer: everything
// the parser's cast lets through is revalidated here, and requiredness depends
// on the claim's honest label. Output is a machine-readable list of gaps, with
// exact reason strings ("falta", "supera conteo declarado", ...).
// See docs/superpowers/specs/2026-10-31-evaluador-design.md (fase 1).
import { parseClaims } from "./contract.js";
import type { Claim } from "./contract.js";

// Machine-readable gap: which claim (when known), which field ("parse" for
// parser-level errors) and an exact reason string.
export interface Gap {
  claim?: string;
  campo: string;
  razon: string;
}

export interface GateResult {
  ok: boolean;
  gaps: Gap[];
  claims: Claim[];
}

// fecha_dato accepts YYYY, YYYY-MM or YYYY-MM-DD (the real data period);
// fecha_consulta is strict ISO YYYY-MM-DD. Calendar sanity is limited to
// month 01-12 and day 01-31; deep per-month validation is out of scope.
const FECHA_DATO = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;
const FECHA_CONSULTA = /^\d{4}-\d{2}-\d{2}$/;

const ETIQUETAS = new Set<string>(["VERIFICADO", "HIPÓTESIS", "PENDIENTE", "NO CONCLUYENTE"]);

// Fields that must be a present string in every claim, regardless of label.
const ALWAYS_STRING: readonly string[] = [
  "id",
  "afirmacion",
  "fuente",
  "url",
  "fecha_dato",
  "fecha_consulta",
  "criterio",
];

function fields(claim: Claim): Record<string, unknown> {
  return claim as unknown as Record<string, unknown>;
}

function monthDayInRanges(month: number | null, day: number | null): boolean {
  if (month !== null && (month < 1 || month > 12)) return false;
  if (day !== null && (day < 1 || day > 31)) return false;
  return true;
}

// Checks a YYYY[-MM[-DD]] string shape and its month/day ranges.
// Returns null when the shape is fine, otherwise the exact gap reason.
function dateGapReason(value: string, strictIso: boolean): string | null {
  const match = strictIso ? FECHA_CONSULTA.exec(value) : FECHA_DATO.exec(value);
  if (match === null) {
    return strictIso
      ? `${JSON.stringify(value)} no es ISO AAAA-MM-DD`
      : `${JSON.stringify(value)} no es AAAA, AAAA-MM o AAAA-MM-DD`;
  }
  const parts = value.split("-").map((p) => Number.parseInt(p, 10));
  // only e.g. "2025-00" or "2025-01-00"; regex already guaranteed digits
  if (!monthDayInRanges(parts[1] ?? null, parts[2] ?? null)) {
    return strictIso
      ? `${JSON.stringify(value)} no es ISO AAAA-MM-DD`
      : `${JSON.stringify(value)} no es AAAA, AAAA-MM o AAAA-MM-DD`;
  }
  return null;
}

function checkClaim(claim: Claim, out: Gap[]): void {
  const push = (campo: string, razon: string): void => {
    out.push({ claim: claim.id, campo, razon });
  };
  const f = fields(claim);

  // Rule 1: always-required string fields (id is revalidated despite the
  // parser guaranteeing it — this gate is the trusted layer over the cast).
  for (const campo of ALWAYS_STRING) {
    const value = f[campo];
    if (value === undefined) push(campo, "falta");
    else if (typeof value !== "string") push(campo, "no es string");
  }

  // Rule 1: dedup must be a boolean; etiqueta must be one of the four labels.
  if (f.dedup === undefined) push("dedup", "falta");
  else if (typeof f.dedup !== "boolean") push("dedup", "no es booleano");

  const etiqueta = f.etiqueta;
  if (etiqueta === undefined) push("etiqueta", "falta");
  else if (typeof etiqueta !== "string" || !ETIQUETAS.has(etiqueta)) {
    push("etiqueta", `etiqueta no válida ${JSON.stringify(etiqueta)}`);
  }
  const verificado = etiqueta === "VERIFICADO";

  // Rule 4: date formats (both revalidated, even though round-tripped through
  // the parser).
  const fechaDato = f.fecha_dato;
  if (typeof fechaDato === "string") {
    const reason = dateGapReason(fechaDato, false);
    if (reason !== null) push("fecha_dato", reason);
  }
  const fechaConsulta = f.fecha_consulta;
  if (typeof fechaConsulta === "string") {
    const reason = dateGapReason(fechaConsulta, true);
    if (reason !== null) push("fecha_consulta", reason);
  }

  // cifra / filas_traidas / conteo_declarado.
  const cifra = f.cifra;
  const filas = f.filas_traidas;
  const conteo = f.conteo_declarado;
  if (verificado) {
    // Rule 2: mandatory under VERIFICADO.
    if (cifra === undefined) push("cifra", "falta");
    else if (typeof cifra !== "string") push("cifra", "no es string");
    if (filas === undefined) push("filas_traidas", "falta");
    else if (typeof filas !== "number") push("filas_traidas", "no es número");
    if (conteo === undefined) push("conteo_declarado", "falta");
    else if (typeof conteo !== "number") push("conteo_declarado", "no es número");
  } else {
    // filas and conteo are a pair: one without the other cannot be compared,
    // so the missing half is "falta" (Review Focus #1).
    if (filas !== undefined && typeof filas !== "number") push("filas_traidas", "no es número");
    if (conteo !== undefined && typeof conteo !== "number") push("conteo_declarado", "no es número");
    if (filas !== undefined && conteo === undefined) push("conteo_declarado", "falta");
    if (conteo !== undefined && filas === undefined) push("filas_traidas", "falta");
  }

  // Rule 3: the comparison itself, only meaningful with both numbers present.
  if (typeof filas === "number" && typeof conteo === "number" && filas > conteo) {
    push("filas_traidas", "supera conteo declarado");
  }

  // Rule 5: licencia required under VERIFICADO; wrong type is a gap too,
  // whatever the label (never two gaps for the same licencia problem).
  const licencia = f.licencia;
  if (licencia !== undefined && typeof licencia !== "string") {
    push("licencia", "no es string");
  } else if (licencia === undefined && verificado) {
    push("licencia", "falta");
  }
}

function gapFromParseError(error: string): Gap {
  // parser-level errors quote the claim id when one is involved:
  // `claim "<id>": ...`; fence-level JSON errors do not.
  const match = /^claim "([^"]+)":/.exec(error);
  if (match === null) return { campo: "parse", razon: error };
  return { claim: match[1], campo: "parse", razon: error };
}

export function runGate(md: string): GateResult {
  const { claims, parseErrors } = parseClaims(md);
  const gaps: Gap[] = parseErrors.map(gapFromParseError);
  for (const claim of claims) checkClaim(claim, gaps);
  return { ok: gaps.length === 0, gaps, claims };
}
