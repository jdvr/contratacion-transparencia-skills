// Report contract: the shape a generated report's claims must have, plus the
// parser that extracts them from fenced ```json blocks in the markdown.
// A fenced json block containing an object with an "id" field is one claim;
// prose around the blocks is ignored, fence counting is not relied upon.
// The parser performs no I/O of its own; the raw report text is its only
// input (see AGENTS.md's evidence contract for what a claim must evidence).
// See docs/superpowers/specs/2026-10-31-evaluador-design.md.

// One piece of evidence, exactly as the report generator must emit it.
// `cifra`, `filas_traidas` and `conteo_declarado` are optional at parse time:
// the structural gate (Task 3) decides when each one is mandatory.
export interface Claim {
  id: string;
  afirmacion: string;
  cifra?: string;
  fuente: string;
  url: string;
  fecha_dato: string;
  fecha_consulta: string;
  criterio: string;
  filas_traidas?: number;
  conteo_declarado?: number;
  banderas: string[];
  dedup: boolean;
  etiqueta: "VERIFICADO" | "HIPÓTESIS" | "PENDIENTE" | "NO CONCLUYENTE";
  licencia?: string;
}

export interface ParseResult {
  claims: Claim[];
  parseErrors: string[];
}

// Fenced ```json blocks, in document order, with the block content captured.
// Lazy body so each match stops at its own closing fence; tolerates trailing
// spaces and CRLF on the open/close lines.
const FENCED_JSON = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;

// Parses a markdown report: collects every fenced ```json block in document
// order, JSON.parses it (malformed blocks become one parseErrors entry and do
// not abort the rest), and keeps blocks whose object has a string "id" as
// claims. Blocks without an "id" are not claims and are skipped silently.
// Minimal per-claim validation during parsing: "banderas" must be present and
// an array (empty is fine); deeper requiredness is the gate's job (Task 3).
// Duplicate "id" values keep the first claim and record a parseErrors entry.
export function parseClaims(md: string): ParseResult {
  const claims: Claim[] = [];
  const parseErrors: string[] = [];
  const seenIds = new Set<string>();

  let index = 0; // 1-based, counts ```json fences (valid or not) in order
  for (const match of md.matchAll(FENCED_JSON)) {
    const content = match[1] ?? "";
    index += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      parseErrors.push(`fence json #${index}: invalid JSON (${message})`);
      continue;
    }

    if (!isRecord(parsed) || typeof parsed.id !== "string") {
      continue; // not a claim-shaped object; not an error
    }
    const id = parsed.id;

    if (!Array.isArray(parsed.banderas) || !parsed.banderas.every((b) => typeof b === "string")) {
      parseErrors.push(
        `claim "${id}": "banderas" is missing or not an array of strings`,
      );
      continue;
    }

    if (seenIds.has(id)) {
      parseErrors.push(`claim "${id}": duplicate id, keeping the first occurrence`);
      continue;
    }
    seenIds.add(id);

    claims.push(parsed as unknown as Claim);
  }

  return { claims, parseErrors };
}

// Returns true for JSON objects (excluding arrays and null).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
