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
  - url                la URL exacta que produjo el dato
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

// Default config when .evaluador/config.json does not exist yet: the cached
// request budget per run (responsible-use decision from the spec).
const DEFAULT_CONFIG = '{"budget": 20}\n';

// Runs the init command scripted: scaffolds <cwd>/.evaluador/ and prints the
// report contract through `stdout` (the CLI passes a writer that preserves the
// trailing newlines of the chunks). Returns exit 0.
// Existing config.json is never touched; when it already exists, a notice
// saying so is printed after the contract.
export async function initScripted(
  cwd: string,
  stdout: (s: string) => void,
): Promise<number> {
  const dotDir = join(cwd, ".evaluador");
  const issuesDir = join(dotDir, "issues");
  const configPath = join(dotDir, "config.json");

  // recursive: creates .evaluador/ and .evaluador/issues/ (empty) in one call,
  // and is a no-op when they already exist.
  mkdirSync(issuesDir, { recursive: true });

  stdout(INIT_CONTRACT);
  if (existsSync(configPath)) {
    stdout(`respetado: ${configPath} ya existe; no se ha tocado\n`);
  } else {
    writeFileSync(configPath, DEFAULT_CONFIG);
  }
  return 0;
}
