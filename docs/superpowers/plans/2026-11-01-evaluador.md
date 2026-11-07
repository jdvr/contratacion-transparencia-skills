# Evaluador Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI `evaluador` que fuerza el cierre de una investigación con gates deterministas, revisión adversarial estructurada sobre OpenCode headless, caché de contenido y salidas md/html/json/issues.

**Architecture:** Orquestador de fases gate→normalización→adversarial (rubric fija, roles frescos)→caché→issues→salidas; toda puerta crítica es código, los modelos solo verdictan vía una capa driver `runAgent()` (v1: subproceso `opencode run`), con estado en `.evaluador/state.json` que permite reanudar por donde se quedó.

**Tech Stack:** TypeScript 5, Node ≥ 22, esbuild (binario único), Vitest. Cero dependencias runtime.

**Spec:** `docs/superpowers/specs/2026-10-31-evaluador-design.md` (aprobado 2026-11-01)

## Global Constraints

- Monorepo: todo el código en `evaluador/`; compila a ejecutable (`evaluador`).
- Exit codes: `0` cero `bloqueante` + todas las labels honestas puestas · `1` deltas/huecos · `2` gate estructural fallido (JSON de huecos) · `3` uso/parseo.
- Contrato por claim (obligatorios excepto los marcados): `id, afirmacion, cifra, fuente, url, fecha_dato, fecha_consulta, criterio, filas_traidas, conteo_declarado, banderas[], dedup, etiqueta∈{VERIFICADO,HIPÓTESIS,PENDIENTE,NO CONCLUYENTE}`; `licencia` solo si se publica.
- Roles solo verdictan (salida estructurada); la reparación es de quien invocó. Rubric en repo, versión `rubricV1` forma parte de la clave de caché; cambio de versión ⇒ caché inválida.
- Allowlist de fetch: la URL debe estar citada en el reporte **y** su host en `ALLOWED_HOSTS` (`datos.canarias.es`, `gobiernodecanarias.org`, `contrataciondelestado.es`, `boe.es`, `ted.europa.eu`). Dominio nuevo ⇒ no fetch ⇒ «sin re-verificación» + señal para el humano.
- Presupuesto de peticiones agotado ⇒ pausa con `no re-verificado: presupuesto agotado`, exit `1`, reanudación desde `state.json` (comportamiento por defecto).
- Uso responsable: budget por defecto 20 peticiones/run, facturación de cada consulta en el manifiesto, preferir API/CSV, cache de descargas.
- Contenido del repo en español; código, identificadores y comentarios en inglés.
- Datos de empresas SIEMPRE generados y etiquetados («DATOS GENERADOS») en fixtures/ejemplos.
- Los tests no tocan la red: el driver es inyectable y los tests usan un driver fake.

## Review Focus

1. **Reporte sin `filas_traidas` cuando hay `conteo_declarado`** — debe fallar el gate con gap `{"claim":…,"campo":"filas_traidas","razon":"falta"}`, no evaluarse como flojo. Test: Task 3.
2. **Caché obsoleta tras bump de rubric** — al subir `rubricV2`, NINGÚN veredicto se sirve de caché aunque el contenido no cambie. Test: Task 7.
3. **Dominio nuevo en una cita** — el driver no hace fetch, marca «sin re-verificación» y añade señal para humano; nunca descarga. Test: Task 5.
4. **Presupuesto agotado a mitad de revisión** — los claims sin revisar quedan marcados `sin-re-verificar`, exit `1`, y un re-run re-revisa SOLO esos. Test: Task 9.
5. **Fixture con pinta de dato real (importes/NIF reales)** — los fixtures usan fecha imposible procedencia (NIF ficticios tipo `555XXXXXX`, cifras con marca), y todo fixture llevа «DATOS GENERADOS». Test: Task 12.

---

## File Structure

```
evaluador/
  package.json tsconfig.json build.mjs        # scaffold del Task 1
  src/cli.ts          # args + exit codes
  src/init.ts         # comando init: imprime contrato + andamia .evaluador/
  src/contract.ts     # tipos Claim/Gap + parser de bloques fenced json
  src/gate.ts         # gate estructural determinista
  src/state.ts        # .evaluador/state.json + canonicalJson + contentHash
  src/driver/types.ts # AgentCall/ AgentResult /Driver
  src/driver/opencode.ts
  src/rubric.ts       # roles, prompts, RUBRIC_VERSION, ALLOWED_HOSTS
  src/cache.ts        # caché de veredictos
  src/budget.ts       # contador de peticiones
  src/adversarial.ts  # orquestación de fases runEval()
  src/issues.ts       # artefactos por problema + severidades
  src/report.ts       # reporte-final.md, HTML, evidencia.json, resumen.json
  test/               # fixtures reporte.md + tests (SIN red; driver fake)
```

---

### Task 1: Scaffold del paquete `evaluador/` y CLI con exit codes

**Files:**
- Create: `evaluador/package.json`, `evaluador/tsconfig.json`, `evaluador/build.mjs`, `evaluador/src/cli.ts`, `evaluador/test/cli.test.ts`

**Interfaces:**
- Produces: binario `evaluador` (npm bin + esbuild a `evaluador/dist/cli.js`); `main() => Promise<number>`, donde `main()` parsea `process.argv` y devuelve el exit code. Todos los comandos aún devolver `3` salvo `--help` (`0`).

- [ ] **Step 1: Crear `package.json`** (name `evaluador`, `type: module`, `bin: {"evaluador": "dist/cli.js"}`, scripts `build`/`test`, devDeps: `typescript`, `esbuild`, `vitest`). `tsconfig` strict, NodeNext. `build.mjs`: esbuild `src/cli.ts`→`dist/cli.js`, `platform: node`, `format: esm`, `banner` con shebang.
- [ ] **Step 2: Write the failing test** (`test/cli.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("cli", () => {
  it("saca exit 3 para comand unknown", async () =>
    expect(await main(["nonsense"])).toBe(3));
  it("saca exit 0 para --help", async () =>
    expect(await main(["--help"])).toBe(0));
});
```

- [ ] **Step 3: Run test to verify it fails** — `cd evaluador && npm test` → FAIL (`main` not defined).
- [ ] **Step 4: Implementar `src/cli.ts`**: `main(argv)` devuelve `3` para args no reconocidos, `0` en `--help`, y deja el switch con `init`/`eval` delegando (por ahora: también `3`, los Tasks siguientes los conectan). Sin parser de terceros.
- [ ] **Step 5: Run test → PASS** (`npm test`). **Step 6: Commit** `feat(evaluador): scaffold cli with exit codes`

### Task 2: Contrato del reporte — tipos y parser de bloques fenced json

**Files:**
- Create: `evaluador/src/contract.ts`, `evaluador/test/contract.test.ts`, `evaluador/test/fixtures.reporte.md`

**Interfaces:**
- Produces:
```ts
export interface Claim {
  id: string; afirmacion: string; cifra?: string; fuente: string; url: string;
  fecha_dato: string; fecha_consulta: string; criterio: string;
  filas_traidas?: number; conteo_declarado?: number;
  banderas: string[]; dedup: boolean;
  etiqueta: "VERIFICADO" | "HIPÓTESIS" | "PENDIENTE" | "NO CONCLUYENTE";
  licencia?: string;
}
export function parseClaims(md: string): { claims: Claim[]; parseErrors: string[] }
```
- `cifra`, `filas_traidas`, `conteo_declarado` son **opcionales en el parser** (el gate del Task 3 decide su obligatoriedad); `banderas` es array (puede venir vacío). Formato de reporte: prose markdown normal que intercala bloques fenced `json` — cada bloque que contenga un objeto con `id` es un claim. Sin depender del contador de fences.

- [ ] **Step 1: fixture** `test/fixtures.reporte.md` — ≥ 3 claims generados y etiquetados `DATOS GENERADOS` al inicio del archivo (NIFs ficticios `555XXXXXX`, cifras redondas absurdas), prose alrededor y un fence json sin `id`.
- [ ] **Step 2: Write the failing test** — (a) 3 claims con los campos exactos del fixture; (b) `banderas` faltante del todo ⇒ elemento en `parseErrors`; `banderas: []` explícito vale; (c) un fence con JSON mal formado va a `parseErrors` y no rompe el resto; (d) prose sin fences ⇒ `claims.length === 0`.
- [ ] **Step 3: Run → FAIL**. **Step 4: Implementar** `parseClaims`: regex de bloques ```json en el orden del documento + `JSON.parse` con try/catch; dedupe de `id` (duplicado → `parseErrors`). **Step 5: Run → PASS. Step 6: Commit** `feat(evaluador): claim types and fenced-json report parser`

### Task 3: Gate estructural (determinista) con huecos máquina-legibles

**Files:**
- Create: `evaluador/src/gate.ts`, `evaluador/test/gate.test.ts`
- Modify: `evaluador/src/cli.ts` (wire `eval <file>`: gate fail ⇒ exit `2` + JSON de huecos por stdout — aún sin fases posteriores)

**Interfaces:**
- Consumes: `Claim`, `parseClaims` (Task 2).
- Produces:
```ts
export interface Gap { claim?: string; campo: string; razon: string }
export function runGate(md: string): { ok: boolean; gaps: Gap[]; claims: Claim[] }
```
- Reglas del gate (exactas):
  1. Obligatorios siempre: `id, afirmacion, fuente, url, fecha_dato, fecha_consulta, criterio, dedup, etiqueta, banderas`.
  2. `cifra`, `filas_traidas`, `conteo_declarado` obligatorios cuando `etiqueta === "VERIFICADO"`; los `PENDIENTE`/`NO CONCLUYENTE`/`HIPÓTESIS` sin cifra son legítimos.
  3. `filas_traidas > conteo_declarado` ⇒ gap con `razon: "supera conteo declarado"`.
  4. `fecha_dato` formato `AAAA` / `AAAA-MM` / `AAAA-MM-DD`; `fecha_consulta` ISO `AAAA-MM-DD` estricto.
  5. `licencia` obligatoria cuando `etiqueta === "VERIFICADO"`. `id`s duplicados y fences con error de parseo (Task 2) también producen gaps con `razon` explícita.
- [ ] **Step 1: Write the failing test** — sobre variantes del fixture: (a) VERIFICADO sin `cifra` ⇒ gap `{campo:"cifra"}`; (b) `filas_traidas: 2112 > conteo_declarado: 1500` ⇒ gap `razon: "supera conteo declarado"`; (c) PENDIENTE sin cifra ⇒ ok (sin gap); (d) `fecha_consulta: "2026-10"` ⇒ gap «no es ISO AAAA-MM-DD» y `fecha_dato: "2026"` vale; (e) el fixture sin tocar pasa `runGate` con `ok: true` y cero gaps.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implementar `runGate`** (reglas 1–5 de arriba; la lista de huecos es salida JSON). **Step 4: Run → PASS. Step 5: Commit** `feat(evaluador): deterministic structural gate with machine-readable gaps`

### Task 4: `evaluador init` — contrato impreso y andamio de `.evaluador/`

**Files:**
- Create: `evaluador/src/init.ts`, `evaluador/test/init.test.ts`
- Modify: `evaluador/src/cli.ts` (comando `init` ya no `3`)

**Interfaces:**
- Produces: `initScripted(cwd: string, stdout: (s: string) => void): Promise<number>`.
  - Crea `<cwd>/.evaluador/` con `issues/` (vacío) y `config.json` `{"budget": 20}` (a menos que exista: no lo toca, y printea que lo respetó).
  - Printea a stdout: el formato de reporte (bloques fenced json + tabla de campos obligatorios copiada del Global Contrato del spec) y las 5 condiciones para exit 0. El texto vive en una const string exportada `INIT_CONTRACT` (parfait mismo por CLI y por test).
- [ ] **Step 1: failing test** — en tmpdir (`mkdtemp`): (a) `.evaluador/config.json` creado con `{"budget":20}`; (b) re-run sobre cwd que ya tiene config ⇒ el archivo NO se toca (idéntico contenido); (c) stdout contiene `banderas` y `NO CONCLUYENTE`; (d) exit `0`. **Step 2: FAIL. Step 3: implementar (mkdir recursive, no sobrescribir). Step 4: PASS. Step 5: Commit** `feat(evaluador): init command scaffolds .evaluador and prints report contract`

### Task 5: Driver interface + driver OpenCode (subproceso) con protocolo de salida structurado

**Files:**
- Create: `evaluador/src/driver/types.ts`, `evaluador/src/driver/opencode.ts`, `evaluador/test/driver.test.ts`

**Interfaces:**
- Produces:
```ts
export type Verdict = {
  claimId: string; role: string;
  resultado: "ok" | "problema" | "sin-re-verificar";
  severidad: "aviso" | "bloqueante";
  hallazgo: string; evidencia: string[];
};
export interface AgentCall { role: string; rubric: string; material: string; allowFetch: string[]; } // allowFetch = URLs permitidas (allowlist ya resuelta en Task 6)
export interface AgentResult { verdicts: Verdict[]; calls: number } // calls = spawns reales (1 + reintentos); el budget (Task 9) lo consume
export type Driver = (call: AgentCall) => Promise<AgentResult>;
export function opencodeDriver(cmd: string = "opencode", runProcess?: SpawnFn): Driver
```
- Comportamiento del driver (exacto):
  1. Spawn `opencode run <prompt>` donde `<prompt>` = rubric + material + "Responde SOLO con un objeto JSON del schema". Con `allowFetch` vacío inyecta la frase «No hagas fetch: marca resultado sin-re-verificar» (allowlist del Task 6; ver test 3).
  2. Extrae del stdout el último bloque fenced `json`, hace `JSON.parse`; valida `Verdict` a mano (los campos del tipo; sin ajv).
  3. Si parse/valida falla: **1 reintento** añadiendo «SOLO JSON, sin texto fuera del bloque». Falla de nuevo ⇒ devuelve `AgentResult{verdicts:[Verdict{resultado:"sin-re-verificar", severidad:"bloqueante", hallazgo:"driver no devolvió veredicto estructurado"}], calls:2}` — nunca lanza.
  4. Si el JSON devuelto trae `role` distinto al de la llamada, se sobrescribe con `call.role`.
  5. `calls` = número de spawns (1 normal, 2 con reintento); la contabilidad en el Budget (Task 9) descuenta exactamente eso.
- [ ] **Step 1: failing test** — inyectando un `runProcess` fake (así el test NO toca la red): (a) stdout con fenced json válido ⇒ Verdict parseado con los fields intactos y `calls:1`; (b) stdout garbage → retry → válido ⇒ ok con `calls:2`; (c) siempre garbage ⇒ resultado `sin-re-verificar` y severidad `bloqueante`; (d) json con `role` incorrecto se sobrescribe con `call.role`; (e) `allowFetch: []` ⇒ el prompt contiene «No hagas fetch». **Step 2: FAIL. Step 3: implementar. Step 4: PASS. Step 5: Commit** `feat(evaluador): driver interface and opencode subprocess driver`

### Task 6: RubricV1 — roles, prompts, versión, allowlist

**Files:**
- Create: `evaluador/src/rubric.ts`, `evaluador/test/rubric.test.ts`

**Interfaces:**
- Produces:
```ts
export const RUBRIC_VERSION = "rubricV1";
export const ALLOWED_HOSTS = ["datos.canarias.es", "gobiernodecanarias.org", "contrataciondelestado.es", "boe.es", "ted.europa.eu"] as const;
export type RoleId = "contadores" | "segunda-fuente" | "falsificador" | "metodico";
export const ROLE_ALIASES: Record<string, RoleId> = { contador: "contadores", segunda: "segunda-fuente", falsificador: "falsificador", metodico: "metodico" };
export const DEFAULT_ROLES: RoleId[] = ["contadores", "segunda-fuente", "falsificador", "metodico"];
export function rubricFor(role: RoleId): string; // prompt template según rol
export function resolveFetch(claim: Claim): { allowed: string[]; blocked: string[] }
```
- Contenido de la rubric (es el juicio de dominio; cada una señala 1 check por rol — copy directo del especificación de controles del repo):
  - `contadores`: filas vs declarado, criterio del total, mezclas adjudicado/estimado/IGIC/anualidad/factura.
  - `segunda-fuente`: contraste por vía lógicamente distinta (CKAN↔CSV↔PLACSP↔BOE↔TED).
  - `falsificador`: GROUP BY alternativo, filtro inverso, rango mayor, caso excluido.
  - `metodico`: cobertura declarada, peticiones, contenedor/encoding, honestidad de etiquetas. (Los ids de rol son ASCII; el rol se presenta como `metódico` en las salidas para el humano.)
- `resolveFetch`: por cada URL en `claim.url` (split si hay varias separadas por espacio): `allowed` si host ∈ ALLOWED_HOSTS; si no, a `blocked`.
- [ ] **Step 1: failing test** — (a) `RUBRIC_VERSION === "rubricV1"`; (b) alias `contador`→`contadores` existe y `contadores` es `RoleId`; (c) `rubricFor("contadores")` menciona «criterio del total»; `falsificador` menciona «GROUP BY»; (d) `resolveFetch` con url de `datos.canarias.es` ⇒ allowed; con `example.com` ⇒ blocked y NO ESTÁ in allowed. **Step 2: FAIL. Step 3: implementar. Step 4: PASS. Step 5: Commit** `feat(evaluador): rubricV1 roles prompts and fetch allowlist`

### Task 7: Caché de veredictos por contenido (rubric version en la clave)

**Files:**
- Create: `evaluador/src/state.ts` (hash + canonicalJson viven aquí), `evaluador/src/cache.ts`, `evaluador/test/cache.test.ts`

**Interfaces:**
- Consumes: `Claim` (Task 2), `RUBRIC_VERSION` (Task 6).
- Produces:
```ts
export function canonicalJson(value: unknown): string;      // claves sortadas recursivamente
export function contentHash(value: unknown): string;        // sha256 hex de canonicalJson({"claim": claim, "rubricVersion": RUBRIC_VERSION})
export class VerdictCache {
  constructor(path: string);                                 // .evaluador/cache.json
  get(h: string, role: RoleId): Verdict | undefined;
  put(h: string, role: RoleId, v: Verdict, model: string, updatedAt: string): void;
  save(): void;                                              // write-back explícito
}
```
- [ ] **Step 1: failing test** — (a) `contentHash` del mismo claim, dos llamadas ⇒ igual; cambie UN campo ⇒ distinto; no depende de orden de claves (dos objetos con claves en orden distinto ⇒ igual); (b) incluso si `contentHash` espera `{claim, rubricVersion}` con claims iguales y `rubricVersion` distinta (`rubricV2`) ⇒ hash distinto (test del Review Focus #2); (c) `get` tras `put`+`save`+nueva instancia del cache (disco roundtrip) devuelve este Verdict. **Step 2: FAIL. Step 3: implementar (canonicalJson: JSON.stringify con claves sortadas recursivas; node:crypto). Step 4: PASS. Step 5: Commit** `feat(evaluador): content-addressed verdict cache keyed by rubric version`

### Task 8: Estado `.evaluador/state.json` + orquestación de fases `runEval()`

**Files:**
- Create: `evaluador/src/adversarial.ts`, `evaluador/test/adversarial.test.ts`
- Modify: `evaluador/src/cli.ts` (comando `eval <file>` llama `runEval` con driver real y `exit` 0/1)

**Interfaces:**
- Consumes: `runGate` (Task 3), `parseClaims` (Task 2), `opencodeDriver` (Task 5), `rubricFor/DEFAULT_ROLES/contentHash` (Tasks 5–7), `VerdictCache` (Task 7).
- Produces:
```ts
export interface RecordedClaim { claim: Claim; hash: string; verdicts: Verdict[]; recheck?: "presupuesto-agotado" | "sin-re-verificar" }
export interface EvaluatorState {
  version: 1; reporte: string; rubricVersion: string;
  claims: RecordedClaim[]; petitions: number; updatedAt: string;
}
export function loadState(dir: string): EvaluatorState | null
export function saveState(dir: string, s: EvaluatorState): void
export async function runEval(opts: {
  reportPath: string; outDir?: string; roles?: RoleId[];
  noCache?: boolean; budget: number; driver: Driver;
  cwd: string;
}): Promise<{ code: 0 | 1 | 2; gaps?: Gap[]; state: EvaluatorState }>
```
- Semántica de runEval (exacta):
  1. Gate fail ⇒ `{code:2, gaps}` (exit 2; NO toca state).
  2. Carga/crea state; para cada claim: hash; para cada role del argumento (o `DEFAULT_ROLES`): si hay hit de caché válido (misma `rubricVersion`) y NO `noCache` ⇒ adopta; si no, `driver({role, rubric: rubricFor(role), material, allowFetch: resolveFetch(claim).allowed})`; guarda veredictos en cache y en state.
  3. Severidad: los veredictos `bloqueante` coleccionan; si el driver devuelve varios veredictos por llamada, el array los adscribe al claim/role correspondiente.
  4. Resultado: `code: 0` si cero `bloqueante` y todos los claims con etiqueta honesta (la etiqueta viene del claim parseado); `code: 1` lo contrario.
  5. **Reanudación**: si state existe y el hash del reporte coincide, SOLO se re-revisan los claims con roles faltantes o con `recheck` marcado; el resto se sirve de state/caché sin tocar el driver (reiniciar «por donde iba» es el comportamiento default — sin flag).
- [ ] **Step 1: failing test** (driver fake inyectado que devuelve veredictos programados y CUENTA las prompts de driver): (a) primer run: 3 claims × 4 roles ⇒ driver llamado 12 veces, code 0; (b) segundo run SIN cambios ⇒ driver llamado 0 veces (caché); (c) cambiar el body de un claim ⇒ 4 llamadas (solo ese claim), state actualizado con hash nuevo; (d) veredicto `bloqueante` en cualquier rol ⇒ code 1; (e) **reanudación**: state con `recheck: "sin-re-verificar"` en claim c2, fake devuelve ok esta vez ⇒ solo c2 re-revisado, code 0. **Step 2: FAIL. Step 3: implementar (state IO + loop de roles/claims + memoías). Step 4: PASS. Step 5: Commit** `feat(evaluador): phase orchestration with resumable state`

### Task 9: Presupuesto de peticiones + Fase 3bis (pausa con hueco declarado)

**Files:**
- Create: `evaluador/src/budget.ts`, `evaluador/test/budget.test.ts`
- Modify: `evaluador/src/adversarial.ts` (inserir Budget entre cache-miss y driver), `evaluador/test/adversarial.test.ts` (nuevos casos)

**Interfaces:**
- Consumes: `Driver` (Task 5); `loadState/saveState` (Task 8).
- Produces:
```ts
export class Budget {
  constructor(max: number); take(n: number): boolean;
  readonly spent: number; readonly exhausted: boolean;
}
```
- RunEval aplica el Budget así: antes de cada llamada al driver, si `spent + 1 > max` NO se llama al driver; el claim/role queda `recheck: "presupuesto-agotado"` en state, issue con `estado:"sin-re-verificar"` y hallazgo «no re-verificado: presupuesto agotado», `code: 1`. El `calls` que devuelve el driver (1, o 2 con reintento) se descuenta tras la llamada; si un reintento se pasa del max se acepta (hasta 1 de desfase) y queda declarado en el manifiesto.
- [ ] **Step 1: failing test** — (a) Budget(2): 2 takes ok, el tercer `take` ⇒ false y `exhausted`; (b) integrado con el fake del Task 8, budget 5, 3 claims × 4 roles: hallar en el state exactamente los pares claim/role sin revisar marcados `presupuesto-agotado`, code 1; (c) re-run con budget suficiente: SOLO las combinaciones claim/role que quedaron sin revisar se re-evalúan (assert del número exacto de llamadas). **Step 2: FAIL. Step 3: implementar (Budget, default 20 de config, flag `--budget`). Step 4: PASS. Step 5: Commit** `feat(evaluador): request budget with declared gap and resumable pause`

### Task 10: Issues como artefactos + mapeo de exit codes con severidad

**Files:**
- Create: `evaluador/src/issues.ts`, `evaluador/test/issues.test.ts`
- Modify: `evaluador/src/adversarial.ts` (emite issues al final de runEval), `evaluador/src/cli.ts` (exit codes $ run `runEval` worked)

**Interfaces:**
- Consumes: `Verdict` (Task 5), `EvaluatorState` (Task 8), config `budget` (Task 4).
- Produces:
```ts
export interface Issue {
  id: string;            // p. ej. "i-001"
  claimId?: string; role: string;
  severity: "aviso" | "bloqueante";
  rubricItem: string;    // qué regla de la rubric falla
  hallazgo: string; propuesta: string;
  estado: "abierta" | "cerrada" | "sin-re-verificar";
}
export function writeIssues(dir: string, verdicts: Verdict[], state: EvaluatorState): Issue[]
```
  - `.evaluador/issues/<id>.json` por issue; `estado: "sin-re-verificar"` para los issues provenientes de recheck/sin crédito; la `propuesta` se deriva del hallazgo (una línea).
  - Git: detrás de flag `--git-branches` (default off en v1), crea `problema/<claimId>` con `git switch -c`; si falla, solo printea warning (nunca exit≠0 por git).
- [ ] **Step 1: failing test** — (a) veredicto bloqueante ⇒ file `.evaluador/issues/i-001.json` con ese JSON y `severity:"bloqueante"`; (b) 2 problemas ⇒ ids secuenciales i-001/i-002; (c) veredicto ok ⇒ NO issue; (d) `--git-branches` sobre un repo temporal (`git init` en tmpdir) ⇒ existe branch `problema/c1`. **Step 2: FAIL. Step 3: implementar. Step 4: PASS. Step 5: Commit** `feat(evaluador): issue artifacts with severity and optional git branches`

### Task 11: Salidas — reporte-final.md, HTML, evidencia.json, resumen.json

**Files:**
- Create: `evaluador/src/report.ts`, `evaluador/test/report.test.ts`
- Modify: `evaluador/src/cli.ts` (`eval -o <dir>` pasa outDir; default: mismo dir del reporte)

**Interfaces:**
- Consumes: `state` + `issues` + `gaps` (Tasks 3, 8, 10).
- Produces:
```ts
export function renderFinalMd(state: EvaluatorState, issues: Issue[]): string
export function renderHtml(state: EvaluatorState, issues: Issue[]): string  // v1: plantilla string inline (sin librerías, sin chart/graph lib): tabla de claims+verdicts+issues con CSS inline
export function renderEvidenciaJson(state: EvaluatorState): string   // claims con toda su evidencia verbatimal, machine-consumible
export function renderResumen(state: EvaluatorState, issues: Issue[]): string
// resumen.json: {claims, bloqueantes, avisos, petitions, presupuesto, cacheHits, cacheMisses, uso_responsable: {...la declaración exacta del spec}}
```
  - El MD lleva chip de atribución «Fuente: Gobierno de Canarias» cuando aplica (según la licencia del claim) y la marca de etiquetas honestas del estilo del repo ([VERIFICADO] / 'Verificado:').
  - HTML simple: tabla + contadores, sin librerías (`dataviz` NO). El grafo de fuentes queda como TODO explícito en el código (`// TODO(v2): source graph`), no al vuelo.
- [ ] **Step 1: failing test** — sobre un state programado (con 1 bloqueante, 1 aviso, 3 claims): (a) MD contiene resumen `bloqueantes: 1`, la etiqueta del claim y «Fuente: Gobierno de Canarias» cuando la licencia lo pide; (b) HTML es string con `<table>` y sin imports de librerías; (c) `evidencia.json` parseado devuelve 3 claims con `url` intacta; (d) `resumen.json` incluye `uso_responsable` con las tres frases del spec: «presupuesto de peticiones declarado», «robots.txt y límites», «cachea localmente». **Step 2: FAIL. Step 3: implementar renderers (template literals, sin librerías). Step 4: PASS. Step 5: Commit** `feat(evaluador): final outputs md html evidence json summary`

### Task 12: Integración del eco (AGENTS.md, playbook, CI) + e2e con driver fake

**Files:**
- Modify: `AGENTS.md` (tabla de enrutado: nueva fila sobre cerrar una investigación con cifras → presentar `evaluador init`), `skills/canarias-datos-publicos-playbook/SKILL.md` (párrafo de cierre con ancla a `evaluador`), `skills/README.md` + `scripts/check-skills.sh` (excluir `evaluador/` de la validación de skills), `.github/workflows/validate-skills.yml` (añadir job o paso `cd evaluador && npm ci && npm test && npm run build`).
- Create: nada más (`evaluador/test/e2e.test.ts` es el único archivo de código nuevo).

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: `evaluador/test/e2e.test.ts` — un run completo de `runEval` sobre `test/fixtures.reporte.md` con driver fake (veredictos programados, datos generados). Asserts: exit code correcto; existen reporte-final.md/html/evidencia.json/resumen.json e issues para el bloqueante; presupuesto respetado (`state.peticiones <= 20`); «DATOS GENERADOS» presente en el fixture (Review Focus #5).

- [ ] **Step 1: e2e failing test** (como arriba; añade aserción que fixture no contenga NIF realista fuera del rango ficticio declarado). **Step 2: FAIL. Step 3: implementar (sin red). Step 4: PASS. Step 5: edits de docs/CI (commit separado, estilo docs). Step 6: Commit** `feat(evaluador): ecosystem integration and e2e with generated data`

---

## Self-review summary

- Cobertura del spec: exit codes (T1, T3, T8, T10), gate determinista (T3), normalización/reanudación (T8), rubric + roles + allowlist (T6), driver opencode (T5), caché por contenido con versión (T7), presupuñoso + 3bis (T9), issues/ramas (T10), salidas (T11), integración (T12). Anti-objetivos: uso responsable en Budget/T11; datos generados en T2/T12.
- Falta a propósito (v2): MCP wrapper, bundle de HTML con grafo de fuentes, publish npm del binario.
