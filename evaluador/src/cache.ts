// VerdictCache (Task 7): a content-addressed store of adversarial-review
// verdicts. The key is the contentHash hex (state.ts) of
// `{"claim": claim, "rubricVersion": RUBRIC_VERSION}`, so any claim edit or
// rubric bump lands on a fresh key and stale verdicts can never be served.
// On disk (`.evaluador/cache.json`, path supplied by orchestration) the shape
// is a JSON.parseable twin of the in-memory store:
//   Record<hash, Record<RoleId, { verdict: Verdict; model: string; updatedAt: string }>>
// Loading is lazy (first get), writes are explicit (`save()`: write-back only
// when orchestration decides); a new instance over the same path re-reads what
// was saved. Unknown role ids on `get` miss (undefined), never throw — the
// role ids are the rubric's ASCII type union, and there is no runtime enum to
// consult. Zero runtime dependencies (node:fs only).
// See docs/superpowers/specs/2026-10-31-evaluador-design.md.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isVerdict } from "./driver/types.js";
import type { Verdict } from "./driver/types.js";
import type { RoleId } from "./rubric.js";
import { writeFileAtomic } from "./state.js";

export interface CachedVerdict {
  verdict: Verdict;
  model: string;
  updatedAt: string;
}

type Store = Record<string, Partial<Record<RoleId, CachedVerdict>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class VerdictCache {
  private readonly path: string;
  private store: Store | null = null; // lazy: null until the first get

  constructor(path: string) {
    this.path = path;
  }

  // Cached verdict for a hash + role, or undefined on any miss. The record is
  // validated on read (verdict literals, string metadata): a corrupt or
  // hand-edited entry is a miss, never a throw and never a bogus adoption.
  get(hash: string, role: RoleId): Verdict | undefined {
    const entry = (this.loaded() as Record<string, unknown>)[hash];
    if (!isRecord(entry)) return undefined;
    const record = entry[role];
    if (!isRecord(record)) return undefined;
    if (!isVerdict(record.verdict)) return undefined;
    if (typeof record.model !== "string" || typeof record.updatedAt !== "string") {
      return undefined;
    }
    return record.verdict;
  }

  // Records a verdict in memory; persistence happens only on save(). A nested
  // entry that is not an object (e.g. a scalar written by another tool) is
  // self-healed to a fresh role map instead of throwing a TypeError.
  put(hash: string, role: RoleId, verdict: Verdict, model: string, updatedAt: string): void {
    const store = this.loaded();
    const existing = (store as Record<string, unknown>)[hash];
    const byRole: Partial<Record<RoleId, CachedVerdict>> = isRecord(existing)
      ? (existing as Partial<Record<RoleId, CachedVerdict>>)
      : {};
    byRole[role] = { verdict, model, updatedAt };
    store[hash] = byRole;
  }

  // Explicit write-back: mkdir -p the parent, then the whole store, pretty
  // JSON (human-inspectable, and re-JSON.parseable by the next instance). The
  // atomic swap keeps a killed process from leaving a truncated cache.
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomic(this.path, JSON.stringify(this.loaded(), null, 2) + "\n");
  }

  // First access reads the file if it exists; an absent, unreadable, corrupt
  // or non-object cache (JSON.parse happily yields null / "5") is an empty
  // store — a cache must never take orchestration down, and `get` must never
  // throw.
  private loaded(): Store {
    if (this.store === null) {
      let fresh: unknown = {};
      try {
        fresh = JSON.parse(readFileSync(this.path, "utf8"));
      } catch {
        // missing file, bad JSON, or a directory hit: start empty
      }
      // Validate after parse: only genuine objects are a store; null, arrays
      // and scalars that JSON-parse cleanly do not count as one.
      if (fresh === null || typeof fresh !== "object" || Array.isArray(fresh)) {
        fresh = {};
      }
      this.store = fresh as Store;
    }
    return this.store;
  }
}
