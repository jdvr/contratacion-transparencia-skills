// The init command: prints the report contract (the serialized evidence
// contract every generated report must follow) and scaffolds the working
// directory <cwd>/.evaluador/ with an empty issues/ dir and a default
// config.json, WITHOUT touching an already existing config.
// Zero runtime deps: node:fs and node:path only.
// See docs/superpowers/specs/2026-10-31-evaluador-design.md #Global Constraints
// and docs/superpowers/plans/2026-11-01-evaluador.md #Task 4.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The printed contract, shared verbatim by the CLI and the tests. It documents
// the report format and marks the boundary the rest of the workflow enforces:
// what a claim must look like, and when the workflow may exit 0.
// The text is human-facing repo content, hence Spanish (repo convention).
export const INIT_CONTRACT = `Contrato del reporte de cierre (evaluador)

Formato del reporte:
El reporte es Markdown; cada afirmación va en UN bloque fenced json
(\`\`\`json ... \`\`\`), y los bloques van en orden de documento. La prosa que
rodea los bloques no se parsea.

Campos obligatorios por afirmación (los marcados entre paréntesis obligan
solo en VERIFICADO, o si se publica):

  - id                 identificador único de la afirmación
  - afirmacion         la afirmación tal y como aparece en el reporte
  - cifra              la cifra concreta (en VERIFICADO)
  - fuente             dataset + resource id / expediente + ficha / notice
  - url                una o varias URLs separadas por espacio; solo se
                       fetchean los hosts de la allowlist (ver Fetch)
  - fecha_dato         el periodo real del dato (≠ fecha de consulta)
  - fecha_consulta     la fecha en que se consultó la fuente
  - criterio           el criterio de selección que define el total
  - filas_traidas      filas realmente traídas (en VERIFICADO)
  - conteo_declarado   el total que declara la fuente (en VERIFICADO)
  - banderas[]         parcialidad: CSV truncado, dataset que empieza en 2020...
  - dedup              si las filas se deduplicaron
  - etiqueta           VERIFICADO / HIPÓTESIS / PENDIENTE / NO CONCLUYENTE
  - licencia           atribución "Fuente: ..." si se publica (en VERIFICADO)

Condiciones para exit 0 (cierre completo):

  1. El gate estructural pasa: los bloques json parsean y ningún campo
     obligatorio falta (falla ⇒ exit 2 con los huecos en JSON).
  2. Toda afirmación lleva una de las etiquetas honestas:
     VERIFICADO / HIPÓTESIS / PENDIENTE / NO CONCLUYENTE.
  3. Cero problemas de severidad \`bloqueante\`.
  4. Las etiquetas honestas no restan: una afirmación bien marcada como
     NO CONCLUYENTE o PENDIENTE es honestidad, no un problema.
  5. Sin huecos sin declarar: una revisión incompleta o un presupuesto
     agotado se declaran (hueco declarado ⇒ exit 1); exit 0 es sin huecos.
`;

// Usage guide (Spanish, like the contract). It is the single source for the
// CLI `help` command and for the `.evaluador/CONTRATO.md` that `init` leaves
// behind, so a working directory can be understood without the repo's README.
export const HELP_GENERAL = `Usage: evaluador <comando> [args]

Comandos:
  init                     Imprime el contrato + esta guía y crea .evaluador/
  eval <reporte.md>        Gate estructural + revisión adversarial
  help [comando]           Esta ayuda, o la de \`eval\` / \`init\`
  --help                   Igual que \`help\`

Flujo: \`evaluador init\` una vez por directorio, escribe el informe y ejecuta
\`evaluador eval reporte.md\`. \`evaluador help eval\` detalla flags, config,
fetch, roles, artefactos y códigos de salida.

Config y fetch: .evaluador/config.json acepta \`budget\` y \`allowHosts\` (hosts
extra autorizados para que el revisor consulte las fuentes citadas).`;

export const HELP_EVAL = `Uso de \`evaluador eval <reporte.md>\`

Flags:
  -o <dir>                  Carpeta de los 4 artefactos (por defecto, junto al informe)
  --no-cache                Ignora la caché de veredictos y re-revisa todo
  --budget N                Tope de llamadas al revisor en esta ejecución
  --roles a,b               Subconjunto de roles (por defecto, los cuatro)
  --model provider/model    Modelo del revisor; forma parte de la clave de caché
  --timeout segundos        Timeout por llamada (300 s por defecto)
  --jobs N                  Pares claim×rol en paralelo (4 por defecto)
  --git-branches            Crea problema/<claimId> para bloqueos (opt-in)

Config (.evaluador/config.json, lo crea \`init\`; tus cambios mandan):
  {"budget": 20, "allowHosts": ["host.ejemplo"]}
  - budget      entero ≥ 0; tope por ejecución si no pasas --budget.
  - allowHosts  hosts extra que autorizas para fetch, además de:
                datos.canarias.es, gobiernodecanarias.org (+ subdominios),
                contrataciondelestado.es, boe.es, ted.europa.eu
                Coincidencia exacta tras quitar un \`www.\` inicial; sin comodines.
  Un valor inválido se ignora (budget 20, sin hosts extra).

Fetch y preflight:
  El revisor solo puede abrir las URLs del campo \`url\` del claim cuyo host esté
  en la allowlist. Por eso \`url\` admite varias URLs separadas por espacio.
  Antes de la primera llamada, \`eval\` avisa por stderr de los claims con 0 URLs
  permitidas y de los que solo tienen 1 (la segunda-fuente no tendrá ruta
  lógicamente distinta), y nombra los hosts bloqueados.

Roles (\`--roles\`, ids ASCII):
  contadores       filas_traidas vs conteo_declarado, criterio del total, mezclas
  segunda-fuente   contraste por vía lógicamente distinta (CKAN/CSV, PLACSP/BOE/TED)
  falsificador     GROUP BY alternativo, filtro inverso, rango mayor
  metodico         cobertura, presupuesto de peticiones, contenedor/encoding, etiquetas
  Alias: contador, segunda. Orden por defecto: contadores → segunda-fuente →
  falsificador → metódico.

Artefactos (por ejecución):
  reporte-final.md / reporte-final.html   informe con claims, veredictos e issues
  evidencia.json                          claims + veredictos, reutilizable
  resumen.json                            contadores de la ejecución
  .evaluador/{state.json,issues/}         estado reanudable e issues abiertas

Códigos de salida:
  0  exit 0: cierre completo, sin bloqueantes y sin huecos
  1  exit 1: terminó con bloqueantes o huecos declarados (issues escritas)
  2  exit 2: el gate estructural falló (JSON con los huecos en stdout; sin estado)
  3  exit 3: error de uso, flag inválido, informe ilegible o roles vacíos`;

export const HELP_INIT = `Uso de \`evaluador init\`

  - Imprime el contrato del informe y esta guía por stdout.
  - Crea .evaluador/config.json con {"budget": 20} si no existe; nunca
    sobrescribe un config existente (tus claves, incluido \`allowHosts\`, mandan).
  - Escribe o refresca .evaluador/CONTRATO.md con este mismo documento, para
    que el directorio de trabajo se explique solo en cualquier sesión.
  - Crea .evaluador/issues/ vacío. El estado y la caché aparecen en el primer
    \`eval\`.`;

// Full document left in the working directory and printed by `init`. Contract
// first (what a claim must contain), then how to use the tool.
export const INIT_GUIDE = `${HELP_GENERAL}

${HELP_EVAL}

${HELP_INIT}`;
export const INIT_DOC = `${INIT_CONTRACT}
${INIT_GUIDE}`;

// Default config when .evaluador/config.json does not exist yet: the cached
// request budget per run (responsible-use decision from the spec).
const DEFAULT_CONFIG = '{"budget": 20}\n';

// Runs the init command scripted: scaffolds <cwd>/.evaluador/ and prints the
// contract + usage guide through `stdout` (the CLI passes a writer that
// preserves the trailing newlines of the chunks). Returns exit 0.
// The guide is also persisted as `.evaluador/CONTRATO.md` (tool-owned, so it is
// refreshed on every run) while a user-owned config.json is never touched; when
// it already exists, a notice saying so is printed after the document.
export async function initScripted(
  cwd: string,
  stdout: (s: string) => void,
): Promise<number> {
  const dotDir = join(cwd, ".evaluador");
  const issuesDir = join(dotDir, "issues");
  const configPath = join(dotDir, "config.json");
  const docPath = join(dotDir, "CONTRATO.md");

  // recursive: creates .evaluador/ and .evaluador/issues/ (empty) in one call,
  // and is a no-op when they already exist.
  mkdirSync(issuesDir, { recursive: true });

  stdout(INIT_DOC);
  writeFileSync(docPath, INIT_DOC);
  if (existsSync(configPath)) {
    stdout(`respetado: ${configPath} ya existe; no se ha tocado\n`);
  } else {
    writeFileSync(configPath, DEFAULT_CONFIG);
  }
  return 0;
}
