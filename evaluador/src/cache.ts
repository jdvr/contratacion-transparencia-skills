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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Verdict } from "./driver/types.js";
import type { RoleId } from "./rubric.js";

export interface CachedVerdict {
  verdict: Verdict;
  model: string;
  updatedAt: string;
}

type Store = Record<string, Partial<Record<RoleId, CachedVerdict>>>;

export class VerdictCache {
  private readonly path: string;
  private store: Store | null = null; // lazy: null until the first get

  constructor(path: string) {
    this.path = path;
  }

  // Cached verdict for a hash + role, or undefined on any miss (including an
  // unknown role id: non-destructive by design, never throws).
  get(hash: string, role: RoleId): Verdict | undefined {
    return this.loaded()[hash]?.[role]?.verdict;
  }

  // Records a verdict in memory; persistence happens only on save().
  put(hash: string, role: RoleId, verdict: Verdict, model: string, updatedAt: string): void {
    const store = this.loaded();
    const byRole: Partial<Record<RoleId, CachedVerdict>> = store[hash] ?? {};
    byRole[role] = { verdict, model, updatedAt };
    store[hash] = byRole;
  }

  // Explicit write-back: mkdir -p the parent, then the whole store, pretty
  // JSON (human-inspectable, and re-JSON.parseable by the next instance).
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.loaded(), null, 2) + "\n");
  }

  // First access reads the file if it exists; an absent or unreadable cache
  // is an empty store (a cache must never take orchestration down).
  private loaded(): Store {
    if (this.store === null) {
      let fresh: Store = {};
      try {
        fresh = JSON.parse(readFileSync(this.path, "utf8")) as Store;
      } catch {
        // missing file, bad JSON, or a directory hit: start empty
      }
      this.store = fresh;
    }
    return this.store;
  }
}
