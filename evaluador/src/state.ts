// Content addressing for the verdict cache (Task 7): `canonicalJson` renders
// any JSON-ish value with recursively key-sorted objects, so two values that
// are equal as data serialize identically; `contentHash` is the sha256 hex of
// that rendering. The orchestrator (Task 8) hashes the payload
// `{"claim": claim, "rubricVersion": RUBRIC_VERSION}`, which pins Review
// Focus #2: a rubric bump (rubricV1 → rubricV2) changes every key and
// invalidates the cache wholesale. Zero runtime dependencies.
// See docs/superpowers/specs/2026-10-31-evaluador-design.md.

import { createHash } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

// JSON.parse-style container check (arrays and null excluded).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Deeply key-sorts objects so member order never affects the output; arrays
// keep their order (positions are meaningful). Numbers, booleans and null go
// out as JSON. `undefined` inside an object drops the key (same treatment as
// plain JSON.stringify); `undefined` inside an array serializes as null.
// Unsupported values the real contract never carries (functions, symbols,
// BigInt) throw exactly as JSON.stringify does; non-finite numbers become
// null, also as JSON.stringify.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// Returns the canonicalized structure; allocations keep the main entry a
// one-liner and the recursion local to this module.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalize(item)));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        continue; // dropped, like JSON.stringify
      }
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

// Atomic file write: the bytes land in `<path>.tmp` first and the rename makes
// the swap atomic within the filesystem, so a crash mid-write never leaves a
// truncated state/cache/output behind (a partial state.json would be read as
// "no resumable state" and silently force a full re-run).
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (error: unknown) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// Content hash: sha256 over the canonical JSON, lowercase hex. The exact
// payload shape is up to the caller (orchestration calls it as
// `contentHash({ claim, rubricVersion })`).
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
