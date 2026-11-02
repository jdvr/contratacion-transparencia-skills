// RubricV1: the versioned adversarial-review roles, their judgment prompts and
// the fetch allowlist. This is the product's core judgment, pinned in the repo:
// it only changes by PR with a version bump (rubricV1 → V2), and the version is
// part of the verdict-cache key (Task 7). The prompts carry one check per role
// — copied from the repo's adversarial controls — plus the shared verdict
// schema; the driver (Task 5) appends its own protocol boilerplate separately,
// so these prompts do not repeat its lines verbatim.
// Zero runtime dependencies; see docs/superpowers/specs/2026-10-31-evaluador-design.md
// (fase 3: "Revisión adversarial estructurada", allowlist de fetch).
import type { Claim } from "./contract.js";

// Bump to rubricV2 (PR only) when the role checks change; invalidates the cache.
export const RUBRIC_VERSION = "rubricV1";

// Exact allowlist (human decision, spec fase 3): a role may only fetch sources
// already cited in the report and domains verified in the skills. Matching is
// exact on the host AFTER normalizing one leading "www." (www.boe.es is
// boe.es). One documented wildcard: any subdomain of gobiernodecanarias.org
// (e.g. istac.gobiernodecanarias.org) is accepted, because the skills use those
// hosts for the same public body. Everything else stays fail-closed: no other
// subdomain and no look-alike suffix passes.
export const ALLOWED_HOSTS = [
  "datos.canarias.es",
  "gobiernodecanarias.org",
  "contrataciondelestado.es",
  "boe.es",
  "ted.europa.eu",
] as const;

// The single host whose subdomains are allowed (ISTAC and other GobCan hosts).
const WILDCARD_HOST = "gobiernodecanarias.org";

// Role ids are ASCII (they travel through JSON, CLI args and cache keys); the
// human-facing presentation of the fourth role carries the accent.
export type RoleId = "contadores" | "segunda-fuente" | "falsificador" | "metodico";

// Short aliases accepted on the CLI / agent requests (e.g. role "contador").
export const ROLE_ALIASES: Record<string, RoleId> = {
  contador: "contadores",
  segunda: "segunda-fuente",
  falsificador: "falsificador",
  metodico: "metodico",
};

// The four independent reviewers: fresh context each, no cross-contamination.
export const DEFAULT_ROLES: RoleId[] = [
  "contadores",
  "segunda-fuente",
  "falsificador",
  "metodico",
];

// Presentation name for human-facing outputs (reports, issues). Only "metodico"
// differs from its role id.
export const ROLE_DISPLAY_NAMES: Record<RoleId, string> = {
  contadores: "contadores",
  "segunda-fuente": "segunda-fuente",
  falsificador: "falsificador",
  metodico: "metódico",
};

interface RoleConfig {
  /** The role's one check, as rubric body (markdown-ish plain text). */
  checklist: string;
}

// Role checklist bodies. The tokens in them ("criterio del total", "GROUP BY
// alternativo", "GROUP BY", "CKAN", …) are the domain-control vocabulary the
// tests pin; keep them intact when editing a rubric.
const ROLES: Record<RoleId, RoleConfig> = {
  contadores: {
    checklist: `## Rows vs declared, criterion of the total, mixed bases

1. Order rows vs declared: countdown the claim against the source's declared
   total: filas_traidas downloaded vs conteo_declarado published by the
   source. A discrepancy is only acceptable when the claim itself explains
   it (documented dedup, a declared export truncation such as a row cap, a
   declared partiality flag). An unexplained gap between the rows brought
   and the declared total is a "problema".
2. The criterion of the total ("criterio del total"): the claim's "criterio"
   field must state in one condition which rows sum into the cifra — period,
   organ, row type. A literal match of a name is NOT a criterion: it filters
   by an arbitrary string, not by a declared selection condition. A cifra
   whose criterion cannot be restated as a row filter is a "problema".
3. Mixed bases ("una suma, un criterio"): check the cifra never sums
   quantities of different kinds — adjudicado amounts vs estimated/budget
   line items, amounts with IGIC vs without it, an anualidad of several
   years vs one, invoiced amounts (facturación) vs adjudications. Mixing
   any of these in one sum is a "problema" with severity "bloqueante":
   the number then counts different things as if they were the same.`,
  },
  "segunda-fuente": {
    checklist: `## Contrast via a logically distinct route

1. A second source means a different route to the same fact, not the same
   route twice: a CKAN API answer contrasted with the raw CSV download of
   the same dataset, the PLACSP expedition ficha contrasted with its
   BOE/TED notice, the transparency portal's published document
   contrasted with the open-data dataset. Re-querying the same endpoint
   with a different filter is NOT a second source; say so if the claim
   presents it as one.
2. Show the route: in "evidencia", name each source you used with its URL
   and the exact datum it yielded, so a human can retrace the contrast
   without your help.
3. If the source cannot be reached within your fetch allowlist (the driver
   passes your URL list alongside this rubric), verdict "sin-re-verificar"
   with severity "aviso". Never fetch outside the allowlist to get a
   comparison, and never guess the contrast number: an unseen domain is a
   human decision, not a missing fetch.`,
  },
  falsificador: {
    checklist: `## Try to break the figure

Your job is to falsify, not to confirm: an attack that fails honestly is
an "ok"; every attack that survives means the claim hid something.

1. GROUP BY alternativo: re-aggregate the material's own evidence with a
   different grouping (by year, by organ, by provider family — mind that
   the acronym of a supplier is not its group; check the group, use the
   NIF) and check whether the new grouping changes the claimed cifra in a
   way the claim hides.
2. Inverse filter: take the exact complement of the claim's criterion and
   look at the excluded rows: does the criterion exclude a case that a
   fair reading would include (a typo'd name, a renamed organ, a
   right-boundary row)? An unfairly excluded case is a "problema".
3. Greater range: widen the period or the set of organs. If the cifra
   breaks, hides an outlier, or turns out to be an artifact of a narrower
   window, the claim overstated its conclusion — "problema".
4. Report which attacks you ran and what each yielded in "evidencia"; an
   unreported attack cannot be retraced and counts as not having run.`,
  },
  metodico: {
    checklist: `## Declared coverage, request budget, container traps, honest labels

1. Declared coverage: the claim must state what was searched (years,
   organs, sources) and what was NOT searched. A figure without its
   declared blind spots ("no encontrado" rows, unlisted portals) is a
   "problema": silence about coverage is not neutrality.
2. Request budget: the number of requests consumed must be traceable
   (declared count, spaced requests, official API/CSV preferred over
   bulk scraping). Undeclared mass fetching degrades a public service —
   flag it; the stance is citizen, not crawler.
3. Container and encoding: check "banderas" acknowledges the container
   traps: content-type, encoding (Latin-1 vs UTF-8 mojibake), delimiter
   surprises, error pages served with HTTP 200, JS-only views without
   data in the HTML, alleged "no data" from a 404 or a fallen search
   endpoint. An unflagged container trap behind the cifra is a "problema".
4. Honest labels: the "etiqueta" must match the evidence actually shown —
   "VERIFICADO" only when the claim carries the cifra with
   filas_traidas and conteo_declarado plus a second-source contrast;
   "HIPÓTESIS", "PENDIENTE" and "NO CONCLUYENTE" are honest when the data
   falls short. An overconfident label is a "problema", and bloqueante
   when it hides an unfilled requirement.`,
  },
};

// The shared header and the verdict contract, interleaved into every rubric.
// The driver appends its own JSON-only output instructions for the backend it
// wraps; these lines phrase the same schema from the reviewer's side without
// copying the driver's protocol text.
const SHARED_INTRO = (role: RoleId): string => `You are one adversarial reviewer of a data-driven report about public
procurement and transparency (Spain / EU / Canary Islands). Your role id is
"${role}", presented to humans as "${ROLE_DISPLAY_NAMES[role]}".

You review exactly ONE claim, in a fresh context: you do not see the other
reviewers and they do not see you. The driver provides the claim (as JSON) and
possibly supporting material after this instruction block; your fetch
allowlist, if any, is passed alongside it. Judge only what is in front of you;
the repairing of a broken claim is the invoking model/human's job, never
yours — you only verdict.`;

const VERDICT_CONTRACT = `## Verdict

- resultado: "ok" (the check passes, after an honest attempt) | "problema"
  (the check found a defect) | "sin-re-verificar" (you could not run the
  check at all: the source is unreachable, outside your fetch allowlist, or
  the material lacks what the check needs).
- severidad: "aviso" (worth flagging; a judgment call) | "bloqueante" (must
  be fixed before the claimed cifra is trusted).
- Every "problema" and "sin-re-verificar" verdict owes a "hallazgo" that
  states exactly what is missing, contradictory or unverifiable, addressed
  to the claim's author, in Spanish.
- "evidencia": the concrete traces backing the verdict (counts, URLs,
  alternative totals), one entry per trace; empty only for a bare "ok".
- Fetch restriction: you may only fetch URLs inside your allowlist (given to
  you by the driver); everything else stays unfetched and human-decided.

Your entire final answer must be EXACTLY one fenced \`\`\`json block containing a
single JSON object with exactly these fields and no others, and nothing else
outside that one fence:
\`\`\`json
{"claimId": string, "role": string, "resultado": "ok"|"problema"|"sin-re-verificar", "severidad": "aviso"|"bloqueante", "hallazgo": string, "evidencia": string[]}
\`\`\`

Echo "claimId" from the claim's "id" and use your own role id for "role".
No prose, no second block and no trailing text outside the single fenced
block.`;

// Returns the full prompt for one role: shared framing, the role's one check
// and the verdict contract. Unknown ids throw (runtime guard over the typed
// seam; aliases must be resolved to a RoleId by the caller).
export function rubricFor(role: RoleId): string {
  const roleConfig = ROLES[role];
  if (roleConfig === undefined) {
    throw new Error(`unknown role: ${JSON.stringify(role)}`);
  }
  return `${SHARED_INTRO(role)}

## Your check

${roleConfig.checklist}

${VERDICT_CONTRACT}`;
}

// Resolves which of the claim's URLs a reviewer may fetch. The claim's "url"
// field may carry several URLs separated by whitespace; each token is routed
// independently. Matching is exact on the lowercase host after dropping one
// leading "www." (so https://www.boe.es/... maps to boe.es), plus the single
// documented wildcard for *.gobiernodecanarias.org. The scheme and port are
// irrelevant; a token without a scheme is checked as an https host anyway.
// Unparseable tokens land in "blocked" (never silently dropped); an
// empty/whitespace-only "url" yields nothing to fetch (an empty "allowed" means
// the agent must not fetch at all).
export function resolveFetch(
  claim: Claim,
): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const token of claim.url.split(/\s+/)) {
    if (token === "") continue;
    const host = urlHost(token);
    if (host !== null && isAllowedHost(host)) {
      allowed.push(token);
    } else {
      blocked.push(token);
    }
  }
  return { allowed, blocked };
}

// www-normalization plus allowlist membership. The wildcard is deliberately
// limited to one entry and anchored with a leading dot, so
// "notgobiernodecanarias.org" and "gobiernodecanarias.org.evil.com" stay blocked.
function isAllowedHost(rawHost: string): boolean {
  const host = rawHost.startsWith("www.") ? rawHost.slice("www.".length) : rawHost;
  if (host === WILDCARD_HOST || host.endsWith(`.${WILDCARD_HOST}`)) return true;
  return (ALLOWED_HOSTS as readonly string[]).includes(host);
}

// Extracts the lowercase hostname of a URL token; scheme-less tokens are
// tried as https URLs. Returns null when the token has no host at all.
function urlHost(token: string): string | null {
  for (const candidate of [token, `https://${token}`]) {
    try {
      const { hostname } = new URL(candidate);
      if (hostname !== "") return hostname.toLowerCase();
    } catch {
      // try the next candidate
    }
  }
  return null;
}
