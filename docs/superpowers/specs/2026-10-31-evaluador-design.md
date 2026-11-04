# Design: `evaluador` — harness de cierre con revisión adversarial forzada

Fecha: 2026-10-31 · Estado: **aprobado por el humano (2026-11-01)** tras builder check; listo para plan.

## Intención y por qué

Este repo resuelve *explorar* datos públicos (skills de conocimiento + AGENTS.md que enruta).
No resuelve *cerrar*: cuando una investigación ya tiene material (p. ej. 40 contratos,
20 fuentes, un borrador de reporte), lo que falta es consistencia, no descubrimiento. Hoy ese
cierre depende de la obediencia del modelo a la prosa de las skills, y falla de dos formas:

1. Cada modelo lanza la revisión adversarial "a lo suyo": rubric distinta, reviewers con contexto
   contaminado, resultados no repetibles.
2. Los controles del contrato de evidencia se recomiendan pero no se fuerzan: el modelo improvise
   (el caso límite: generar 88 millones de hashes en una respuesta en lugar de escribir un
   script que lo haga).

`evaluador` es la respuesta: **un ejecutable único, opinionated, con tools limitadas y un solo
workflow** — el cierre. No es una plataforma genérica ni sustituye la exploración con skills:
es el paso final que convierte el contrato de evidencia en código que fuerza el flujo.

## Objetivos

- Forzar el cierre con gates estructurales en código: no se avanza de fase hasta que la
  anterior produce su artefacto válido.
- Revisión adversarial **estructurada y repetible**: rubric fija, agentes independientes con
  contexto fresco por rol, veredictos comparables entre ejecuciones.
- **Delta-review con caché de contenido** (patrón Gradle): hash por afirmación/sección; lo
  inalterado se aprueba por caché; solo se re-revisa el delta. Re-runs baratos.
- Salidas: reporte final (MD y HTML enriquecido), JSON estructurado, y cada problema detectado
  como artefacto/issue (y rama de git cuando exista repo).
- Invocable desde cualquier host: CLI plano; un modelo puede prepararlo y ofrecerlo al humano.
- Degradación graceful: hosts sin MCP ni subagents siguen teniendo skills+scripts+AGENTS.md;
  `evaluador` solo es un binario que llamar.

## No-objetivos

- No es un framework de agentes ni un runtime genérico: un workflow, sin configuración de fases.
- No explora ni busca datos: su entrada es un reporte ya producido (por humano o modelo con
  skills). Si falta material, se detiene y lo pide.
- No reescribe las skills ni el AGENTS.md existentes; solo añade anclajes de handoff.
- v1 no migra a ai-sdk/langchain (ver Enfoques); solo deja la costura para hacerlo v2.

## Anti-objetivos (qué sería un fallo aunque funcione)

- Un evaluador que confía en que el modelo se autoverifique: toda puerta clave es código
  determinista, la llamada a modelo es refinamiento, no gate.
- Mezclar criterios del total (adjudicado vs estimado, IGIC, anualidad, facturación).
- Violación del uso responsable de los portales: el propio evaluador respeta presupuesto de
  peticiones, `robots.txt`, cache de descargas y crawl-delay — y las *declara* en su salida.
- Publicar datos reales de empresas en ejemplos/tests: solo datos generados etiquetados.

## Restricciones

- Monorepo: todo el código del harness vive en `evaluador/` dentro de este repo; compila a
  artefacto ejecutable.
- v1 corre sobre **OpenCode headless** (`opencode run`/SDK): reutiliza auth/config y agnosticismo
  de provider gratis. La dependencia se aísla en una capa driver fina (ver abajo).
- El gating de fases es orquestación *entre* llamadas, no control intra-llamada: por eso bastan
  agentes con salida estructurada para v1.
- El formato del reporte de entrada es el contrato serializado del contrato de evidencia del
  playbook (fuente, URL, criterio, fechas, filas vs declarado, banderas, licencia, etiquetas).
- Español en contenido; código y comentarios de infraestructura en inglés (convención del repo).

## Enfoques considerados

| Enfoque | Qué es | Por qué no (o sí) |
|---|---|---|
| **A. Repo federado (elegido)** | skills+AGENTS.md (conocimiento) + scripts que muerden + `evaluador` (enforcement del cierre) | Cada capa en su sitio; degradación graceful; el conocimiento ya está bien hecho |
| B. Harness tipo subagente de host | agente markdown (formato Claude Code) con sysprompt | Enforcement dependiente del host (como opencode.jsonc); Codex no soporta subagents custom; sin gates de código |
| C. MCP-first | todo como tools con el conocimiento en docstrings | Máximo determinismo pero pierde la narrativa del dominio (las trampas no caben en un schema); coste alto de mantenimiento |

Decisiones tomadas con el humano tras el builder check (2026-11-01): severidades `aviso`/`bloqueante` con exit 0 solo sin bloqueantes y etiquetas honestas puestas; rubric en repo con PR + versión que invalida caché; presupuesto agotado ⇒ pausa con hueco declarado y reanudación desde `state.json`; allowlist de fetch (fuentes citadas + dominios verificados en skills; dominio nuevo ⇒ no fetch).

Micro-decisiones dentro de A:

- **Pre-eval mecánico, no de modelo**: el gate de entrada es parsing estructural (gratis,
  inengañable; el "modelo dice si hay fuentes" queda como lint opcional posterior).
- **Fallback declarado** (propuesta del humano, adoptada): si el reporte llega sin formato,
  `eval` se detiene pidiendo completar fuentes en vez de evaluar algo flojo.
- **Runtime v2**: ai-sdk como driver swap previsto; langchain descartado (más abstracción para
  orquestar pocas llamadas con gates).

## Producto

### CLI

```bash
evaluador init                 # documenta el contrato del reporte y andamia la carpeta de trabajo
evaluador eval reporte.md [-o salida/] [--no-cache] [--roles contador,segunda,falsificador]
```

Exit codes (contrato con el host que invoca):

- `0` — cierre completo: **cero problemas de severidad `bloqueante`** y toda afirmación con su
  etiqueta honesta. Las etiquetas `HIPÓTESIS`/`PENDIENTE`/`NO CONCLUYENTE` bien marcadas no son
  problemas: son honestidad, no resta del exit 0.
- `1` — evaluación completada con deltas: existen problemas (severidades `aviso` y/o
  `bloqueante`) como artefactos, o revisiones incompletas con hueco declarado (ver Fase 3bis).
- `2` — gate estructural fallido; salida JSON máquina-legible con los huecos exactos.
- `3` — error de uso / reporte no parseable como texto.

### Fases de `eval` (forzadas por el orquestador)

1. **Gate estructural** (determinista, código): parsea el reporte al formato contrato. Cada
   afirmación debe llevar: `id`, `afirmacion`, `cifra`, `fuente` (dataset+resource/ruta),
   `url`, `fecha_dato` (periodo real), `fecha_consulta`, `criterio`, `filas_traidas` vs
   `conteo_declarado`, `banderas[]` de parcialidad, `etiqueta` VERIFICADO/HIPÓTESIS/PENDIENTE/
   NO CONCLUYENTE, `dedup`, `licencia` si aplica. Falla con exit 2 y lista de huecos por
   `claim.id` — el modelo que invocó puede leerla y reparar el reporte (repitable hasta pase).
2. **Normalización**: estado interno en `.evaluador/state.json` (fuentes, afirmaciones,
   evidencia, manifiesto de hashes). Es el artefacto sobre el que viven la caché y los deltas.
3. **Revisión adversarial estructurada**: rubric fija versionada en el código; roles
   independientes con contexto fresco (sin contagiarse entre sí ni del borrador del reporte):
   - `contadores` — contar vs declarado, criterio del total, mezclas adjudicado/facturado.
   - `segunda-fuente` — contraste por vía lógicamente distinta (CKAN↔CSV↔PLACSP↔BOE↔TED).
   - `falsificador` — intentar romper la cifra propia (GROUP BY alternativo, filtro inverso,
     rango mayor, caso excluido).
   `metódico` — cobertura declarada, peticiones consumidas, contenedor/encoding, honestidad
     de etiquetas.
   Los roles pueden disponer de tools limitadas (fetch con cache de descargas + rate limit) para
   re-verificar contra la fuente; cada consulta queda facturada en el manifiesto.

   **Allowlist de fetch** (decisión del humano): un rol solo consulta fuentes ya citadas en el
   reporte y dominios verificados en las skills (datos.canarias.es, contrataciondelestado.es,
   BOE, TED, ISTAC…). Ante un dominio nuevo, el rol **no hace fetch**: lo marca como «sin
   re-verificación» y lo deja señalado para decisión humana. La postura «ciudadano, no crawler»
   manda.

   **Gobernanza de la rubric** (decisión del humano): la rubric vive en el repo, aprobada como
   parte de este diseño; solo cambia por PR con incremento de versión (`rubricV1 → V2`), y el
   cambio de versión **invalida explícitamente la caché de veredictos** (la versión de rubric es
   parte de la clave de hash). Si un rol "repara", no cuenta: los roles solo verdictan con
   salida estructurada; la reparación la hace el modelo/humano que invocó.

   **Fase 3bis — presupuesto de peticiones agotado** (decisión del humano): no se aborta el run
   ni se sale en silencio. El evaluador detiene la re-verificación en ese punto, marca cada
   afirmación pendiente como `no re-verificado: presupuesto agotado` en su issue, y sale exit 1
   con el hueco declarado. Un re-run con presupuesto suficiente (o la caché, si nada cambió)
   reanuda la revisión justo donde se quedó — el estado en `.evaluador/state.json` hace que
   reiniciar "por donde iba" sea el comportamiento por defecto.
4. **Delta-review con caché de contenido**: hash estable por afirmación (cuerpo + evidencia).
   Veredicto prior: caché hit → se adopta y se marca; solo misses van a review. `--no-cache`
   fuerza revisión completa. La caché vive en `.evaluador/cache.json` y registra fecha/roles/model.
5. **Deltas como artefactos**: cada problema detectado genera artefacto `.evaluador/issues/<id>.json`
   (severidad, claim, rubric, evidencia del problema, propuesta de siguiente paso); con git
   disponible, opcionalmente rama `problema/<id>` con mini-informe pendiente de próxima pasada
   de review — solo del contenido cambiado.
6. **Salidas**: `reporte-final.md` (y HTML enriquecido con grafo de fuentes/afirmaciones cuando
   aplique), `evidencia.json` (estructurado, máquina-consumible), `resumen.json` (counts:
   afirmaciones, problemas, peticiones, coste estimado en llamadas; y la declaración de uso
   responsable). El summary final llama a las etiquetas honestas del repo.

### Capa driver (la costura para v2)

Interfaz mínima que el orquestador usa y las fases no ven:

```
runAgent({ role, rubric, material, allowTools, outputSchema }) → { verdict: JSON, stats: {tokens, calls} }
```

- Implementación v1: OpenCode headless (SDK/`opencode run`), salida estructurada forzada en cada llamada.
- v2 (driver alternativo): ai-sdk — swap del driver sin tocar fases ni rubric.

## Integración con el ecosistema (toques, no reescrituras)

- `AGENTS.md`: nueva fila de enrutado — "¿hay investigación con material suficiente que deba
  cerrarse con cifra?" → presentar `evaluador init` al humano con los datos ya en la mano.
- `canarias-datos-publicos-playbook` (y equivalentes): párrafo de cierre con ancla a `evaluador`.
- `skills/README.md` + `mantenimiento`: el checklist pasa a mencionar que las cifras de ejemplos
  pueden cerrarse vía `evaluador`.
- `scripts/check-skills.sh`: exclusiones para el árbol `evaluador/` (no es una skill).

## Qué queda para el builder (no decidido aquí)

- Lenguaje/build: TypeScript+esbuild→binario único recomendado (SDK de opencode es TS; npm
  distributable). Alternativa: Python+uv si el equipo prefiere data-first.
- Detalle del driver: SDK server vs `opencode run` por llamada (overhead por invocación).
- Esquemas JSON exactos (state.json, issues, evidencia.json, rubric versionada).
- Plantilla HTML del reporte enriquecido (grafo de fuentes: librería o inline).
- Mecánica de ramas `problema/<id>` (cuándo crearlas, qué contienen, cómo se reconcilian).
- Tests: unit para gates deterministas; 1 e2e con datos generados; test adversarial del propio
  evaluador con agente fresco (metodología del repo).
- CI: qué se valida del árbol `evaluador/` en GitHub Actions.

## Distribución y apertura

Dentro del repo (monorepo). El binario/npm es opcional publicarlo aparte más adelante; para
"cualquier host" basta que `evaluador` sea ejecutable plano: Claude Code, Codex, OpenCode,
Gemini CLI pueden invocar la misma CLI sin saber nada del harness por dentro. Wrapper MCP opcional
futuro (una tool `evaluador_eval`) ya contemplado que no cambia el CLI.
