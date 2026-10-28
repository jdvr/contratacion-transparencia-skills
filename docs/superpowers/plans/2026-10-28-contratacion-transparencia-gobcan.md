# Plan: repo `contratacion-transparencia-skills` (skills + AGENTS.md de contratación y transparencia pública)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir este repositorio en un proyecto clonable y listo: skills de agente verificadas en tres capas (estatal/europea, CKAN genérico, Canarias), AGENTS.md enrutador con contrato de evidencia y revisión adversarial, README, ejemplos, git e historial limpio.

**Architecture:** `skills/` como fuente canónica (una skill = un SKILL.md, estilo canarias); `opencode.jsonc` declara `"skills": ["./skills"]` para descubrimiento cero-config; `AGENTS.md` enruta por origen del órgano/portal entre las tres capas; `examples/` lleva transcriptos verificados; `.local-mining/` (gitignored) conserva el material minado. El repo se renombra de `transparencia-gobcan-skills` a `contratacion-transparencia-skills` como paso inicial. Ejecución nativa en esta sesión (decisión del usuario).

**Tech Stack:** Markdown + YAML frontmatter, JSONC, git; verificación en vivo con `webfetch`/`curl`.

**Spec:** `docs/superpowers/specs/2026-10-28-contratacion-transparencia-gobcan-design.md` (leer junto al plan; su §9 — revisión adversarial y controles — es requisito de aceptación transversal).

## Global Constraints

- Toda la prosa en español; inglés solo en código, headers HTTP y nombres de campo (criterio nº 5).
- Frontmatter de cada SKILL.md: `name` (= nombre del directorio, kebab-case) + `description` "Use when..." en español con disparadores y señales de fallo.
- Cada SKILL.md nueva ≤ 160 líneas, estilo canarias: idea central bold, mapa real, recetas copy-pasteables con salida esperada, tabla de Trampas `Síntoma | Realidad`, checklist final. skills/README.md (Task 7) fija el patrón y la convención `<comunidad>-*`.
- **Sección obligatoria "Controles y revisión adversarial" en cada skill nueva** (spec §9.4), con los checkpoints aplicables a su dominio; AGENTS.md la presenta como marco obligatorio.
- **Uso responsable en AGENTS.md y README** (spec §6.4): los portales son servicio público; presupuestos declarados, espera entre peticiones, no scraping masivo, cachear lo descargado.
- Marca "Verificado: <fecha>" en cada skill; lo no re-ejecutado hoy se marca "(de sesiones, no re-ejecutado hoy)" — solo la receta Datalab queda histórica (API de pago).
- Nada de material confidencial de <workspace propio> (quejas de app, correos, personas físicas); solo datos públicos (expedientes, importes, NIF de empresas, URLs oficiales).
- Cero rutas personales (`/Users/...`) ni claves en ficheros versionados.
- Licencia CC BY 4.0; la publicación en remote la hace Juan a mano.
- Presupuestos en vivo: ≤10 peticiones PLACSP, ≤6 TED, ~5 para re-check de CKAN, espaciadas ~1 s; si un check falla, se documenta y se sigue.
- Material minado: `.local-mining/sesiones/*.md` (11 transcriptos) y `.local-mining/informes-extraccion.md` (digesto A/B/C). Citas verbatim de ahí, nunca de memoria.

## Review Focus

1. **Descubrimiento**: OpenCode apuntando al repo lista las skills del repo (placsp, doue-ted, ckan, canarias-datos-abiertos, canarias-datos-publicos-playbook, canarias-transparencia-portal, mantenimiento). Test Task 11 vía `/api/skill`.
2. **Sin filtración**: ningún fichero versionado con `/Users/`, `DATALAB_API_KEY`, contenido quejoso de <workspace propio>, ni `.local-mining` en el índice (grep + `git check-ignore`).
3. **Enrutado coherente 3 capas**: el AGENTS.md y el playbook asignan cada tarea a una skill primaria sin contradecirse (canario→canarias; otro órgano ES→placsp; UE→doue-ted; CKAN de otra comunidad→ckan). Test Task 11 con subagente fresco.
4. **Tokens exactos**: tokens `idEvl`/UUID URL-encoded tal cual; test Task 4 re-ejecutando la ficha en vivo.
5. **Adversarial presente y concreta**: cada skill nueva con su sección de controles y las 5 partes del marco (§9.1-9.2) referidas a su dominio; AGENTS.md las hace obligatorias. Grep Task 10.

---

### Task 1: Renombrar repo + scaffolding — git, LICENSE, config limpia

**Files:**
- Rename: `~/workspace/transparencia-gobcan-skills` → `~/workspace/contratacion-transparencia-skills`
- Create: `LICENSE` (CC BY 4.0)
- Modify: `opencode.jsonc`
- Modify: `~/.config/opencode/` (global, si no existe crear)

**Interfaces:**
- Produces: repo git en la ruta nueva; `opencode.jsonc` exacto `{"$schema","skills"}`; permisos personales fuera del repo; sesión re-anclada con `session_move`.

- [ ] **Step 1: mover permisos personales a la config global** (array `permissions` con las 3 reglas de <workspace propio>; fusionar, no borrar nada previo). Verificar con `opencode api get /api/config`.
- [ ] **Step 2: `opencode.jsonc` del repo = schema + `"skills": ["./skills"]`** (nada más).
- [ ] **Step 3: `mv` del directorio + `session_move` de la sesión a la ruta nueva**; sanity: `pwd` y ficheros presentes.
- [ ] **Step 4: LICENSE CC BY 4.0 + `git init` + primer commit** (`chore: scaffolding del repo (git, licencia CC BY 4.0, config limpia)`); `git check-ignore .local-mining` exit 0.

### Task 2: Portar las 3 skills canarias verbatim

**Files:**
- Create: `skills/canarias-*` (3 SKILL.md desde `~/.claude/skills/`)

- [ ] **Step 1: copiar** sin editar.
- [ ] **Step 2: `diff` contra origen** → vacío en las 3.
- [ ] **Step 3: commit** `feat: portar skills canarias (verbatim desde ~/.claude/skills)`.

### Task 3: Skill `ckan` (nueva, genérica)

**Files:**
- Create: `skills/ckan/SKILL.md`

**Interfaces:**
- Consumes: digesto §B (patrón CKAN genérico vs partes GobCan) y `sesiones/` para ejemplos.
- Produces: convención de nombres de endpoints que `canarias-datos-abiertos` enlazará (Task 4).

- [ ] **Step 1: separar lo genérico de lo GobCan** en el material (los patrones CKAN-transferibles: error de raíz `/api/3/action`, `package_search` params (`q/fq/rows≤1000/fl/mm=100%/facetas`), `datastore_search` (tope 32.000, paginación offset), `datastore_search_sql` y sus 500s por columna, `datastore_active:true` que miente, CSV Latin-1 `;`, dollar-quoting en zsh, facetas/ licencias; señales de lectura del `status_show`/versión).
- [ ] **Step 2: escribir SKILL.md** (~90-120 líneas): idea central (CKAN es software genérico; el mismo truco sirve en datos.gob.es y portales autonómicos **si** localizas la ruta real de la API con `status_show`; escribir ruta raíz típica y el patrón de rutas vivas), mapa real genérico (tabla patrón↔significado con ejemplos GobCan marcados como instancia), recetas genéricas (descubrir API: `/api/3/action/status_show` en candidatos; buscar/ficha/count/SQL; CSV con codificación), tabla de trampas (≥8 filas, todas transferibles), sección **Controles y revisión adversarial** (contar vs declarado; segunda fuente; content-type; criterio explícito; etiquetas honestas), marca "Verificado: 2026-10 en datos.canarias.es (CKAN 2.9-2.11); patrón genérico no re-verificado en otros portales".
- [ ] **Step 3: chequeos** (grep de secciones, tabla ≥8 filas, ≤120 líneas, sin `/Users/`).
- [ ] **Step 4: commit** `feat: skill ckan (patrones genéricos de portales de datos)`.

### Task 4: conectar `canarias-datos-abiertos` con `ckan` + router playbook

**Files:**
- Modify: `skills/canarias-datos-abiertos/SKILL.md` (una línea, no reescribir: nota de que los patrones genéricos CKAN vivan en skill `ckan`; este skill mantiene los datos y trampas GobCan)
- Modify: `skills/canarias-datos-publicos-playbook/SKILL.md` (tabla de enrutado ampliada)

**Interfaces:**
- Consumes: nombres fijados (Task 3/5/6): `ckan`, `placsp`, `doue-ted`.
- Produces: tabla de enrutado estable que AGENTS.md (Task 9) referenciará: "cifra agregada contratos órgano canario → `canarias-datos-abiertos`"; "expediente/pliego concreto ES → `placsp`"; "anuncio UE → `doue-ted`"; "portal CKAN de otra comunidad → `ckan`"; "documentos de transparencia GobCan → `canarias-transparencia-portal`".

- [ ] **Step 1: nota de una línea en datos-abiertos** (después de la idea central, con referencia por nombre en backticks).
- [ ] **Step 2: ampliar tabla del playbook** con las filas de arriba.
- [ ] **Step 3: sync local**: `cp` de ambos ficheros a `~/.claude/skills/canarias-*/` (copia global = repo; flujo de Juan no diverge).
- [ ] **Step 4: verificación + commit** (`diff` global vs repo vacío; commit `feat: enrutado entre capas en playbook y datos-abiertos`).

### Task 5: Skill `placsp` (nueva, capa estatal)

**Files:**
- Create: `skills/placsp/SKILL.md`

**Interfaces:**
- Consumes: digesto §A (tokens `idEvl` con expedientes, cadenas de ficha/servlet/UUID, trampas, Datalab) y transcriptos `contratos-unificacion-visor`, `Historia-clinica-expedientes-contratacion.md`.

- [ ] **Step 1: re-verificación en vivo (≤10 peticiones)**: ficha de un expediente real con su `idEvl=<token>` en vivo, ficha de otro expediente, y un servlet `GetDocumentByIdServlet` conocido → respuesta (no 000). Los tokens concretos y datos de empresa no se publican (higiene); se anotan content-types y estructura. URL muerta → se marca como rota con sustituto.
- [ ] **Step 2: escribir SKILL.md** (~120-160 líneas): alcance estatal en la idea central (cualquier órgano de contratación español; ejemplos SCS como casos verificados); frontmatter Spanish "Use when" con señales de fallo (curl 000, tokens, búsqueda débil); tabla mapa real; recetas (noticia→expediente con regla de primaria; retro-cronología BOE con IDs adyacentes; pliegos; PDF→markdown con Datalab — bloque completo del spec §6.1 con marca histórica); tabla Trampas ≥15 filas del digesto (renumeración anual, A/N, pliego anulado, cuadro características ≠ pliego, tokens rotos al decodificar, curl 000, "licitado" sin dictamen, alias falsos de empresa, NIF corruptos, producto ≠ proveedor, corte alfabético del CSV, importes con/sin IGIC, anualidad vs plurianual); **sección Controles y revisión adversarial** (contar/segunda fuente/criterio/aritmética + intento de falsificación: buscar el complemento del criterio; cobertura declarada; etiquetas); registro de tokens conocidos; "Verificado: 2026-10-28 (fichas 0016 y N/0021 en vivo; resto de sesiones)".
- [ ] **Step 3: chequeos** (tabla ≥15; secciones; ≤160 líneas; sin rutas personales).
- [ ] **Step 4: commit** `feat: skill placsp (gramática de ficha, documentos, BOE, Datalab, controles adversariales)`.

### Task 6: Skill `doue-ted` (nueva, capa europea)

**Files:**
- Create: `skills/doue-ted/SKILL.md`

- [ ] **Step 1: re-verificación en vivo (≤6 peticiones)**: `POST https://api.ted.europa.eu/v3/notices/search` con `{"query":"publication-number=<N>-<AÑO> (notice de ejemplo)","fields":["publication-number","notice-title"],"limit":3}` → success; `https://ted.europa.eu/en/notice/<N>-<AÑO> (notice de ejemplo)/xml` → XML con `cbc:*Amount`; una query con campo inexistente → error con lista válida (copiar esos nombres a la skill).
- [ ] **Step 2: escribir SKILL.md** (~90-130 líneas): idea central (API v3 sí acepta curl; las páginas detalle con webfetch a menudo fallan; los errores de la API son documentación — descubrimiento de campos); mapa real (endpoints exactos); receta puente PLACSP↔TED (los números TED aparecen en las fichas; <N>-<AÑO> (notice de ejemplo) = modificación de N/0097; importes en `PayableAmount` vía XML+grep/python); DOUE serie S (EUR-Lex) marcado como no verificado hoy si no entra en presupuesto; tabla trampas 5-8 filas; **sección Controles y revisión adversarial** (cifra del XML vs ficha PLACSP: doble fuente; una cifra = dos fuentes; fecha de publicación ≠ fecha de modificación); "Verificado: 2026-10-28 (API v3 y XML de ejemplo en vivo)".
- [ ] **Step 3: chequeos + commit** `feat: skill doue-ted (API TED v3, XML, puente con PLACSP)`.

### Task 7: Índice y patrón de skills (`skills/README.md`)

**Files:**
- Create: `skills/README.md`

- [ ] **Step 1: escribir** (70-100 líneas): tabla de las skills del repo ("Uso para:"/"Verificado"); convención de capas y de nombres (`<comunidad>-*`); **checklist para añadir una skill** (incluye, obligatorio: tabla de trampas verificada, marca de verificación, y test adversarial GREEN con agente fresco + corrección de errores detectados, como hizo la validación 2026-10); síntesis de las 5 reglas de estilo canarias.
- [ ] **Step 2: commit** `docs: índice de skills y patrón para añadir`.

### Task 8: Ejemplos verificados

**Files:**
- Create: `examples/ejemplo-proveedor-por-nif.md`
- Create: `examples/ejemplo-cadena-de-contratos.md`

**Interfaces:**
- Consumes: transcriptos de sesiones en `.local-mining/sesiones/` (busca por proveedor unificado y cadena de contratos); cifras y fuentes cruzadas con `dossier-unificacion.md` (<workspace propio>, solo lectura) — nada nuevo inventado.

- [ ] **Step 1: ejemplo 1** (proveedor ficticio por NIF/concepto): tarea → comandos CKAN (SQL + dollar-quoting) → resultado con criterio (N/0097 1.400.000,10 € (ficticio); N/0021 1.800.000,00 € (ficticio); modificación ficticia (+100.000,00 €) TED <N>-<AÑO> (notice de ejemplo); total 3.200.000,10 € (ficticio)) → fuentes con URL exacta → **casilla de controles aplicada** (criterio, segunda fuente, cobertura).
- [ ] **Step 2: ejemplo 2** (saga el proyecto de unificación (ficticio) 2013→2026): tabla Periodo|Expediente|Importe|Adjudicataria|Fuente con etiquetas [VERIFICADO]/[HIPÓTESIS]/[PENDIENTE], exclusivamente fuentes PLACSP/BOE/TED/anuncios oficiales.
- [ ] **Step 3: chequeos + commit** — grep de filtración vacío; commit `docs: ejemplos verificados (el proveedor de ejemplo (ficticio), saga el proyecto de unificación (ficticio))`.

### Task 9: AGENTS.md raíz

**Files:**
- Create: `AGENTS.md`

- [ ] **Step 1: escribir** (~110-140 líneas): (1) "Carga la skill correcta ANTES de explorar"; (2) contrato de evidencia 7 ítems arriba; (3) marco obligatorio de controles y revisión adversarial (aplicando §9: intenta falsificar tu cifra, segunda fuente, cobertura, etiquetas); (4) tabla frase→skill de 3 capas; (5) método de trabajo (presupuesto, sleep 1-2 s, robots.txt, cachear, subagentes por dominio); (6) bloque "Uso responsable" (tono ciudadano del spec §6.4); (7) "Nunca" (concluir "no hay datos" de un 404 o vista JS; sumar adjudicado y llamarlo pagado; citar agregador sin primaria; automatizar solicitudes SAIP — requieren certificado y pasan a la persona).
- [ ] **Step 2: chequeos + commit** (grep de las skills del repo; commit `docs: AGENTS.md raíz (enrutado, evidencia, adversarial, uso responsable)`).

### Task 10: README.md raíz

**Files:**
- Create: `README.md`

- [ ] **Step 1: escribir** (~90-130 líneas): nombre nuevo que incluye el significado; qué es; **aviso de alcance por capas** (nace en Canarias; `placsp`/`doue-ted`/`ckan` valen para toda España, otras comunidades bienvenidas con la convención `<comunidad>-*` — literal del spec §6.5/§1); tabla de skills con "Verificado"; "Clonar y usar" OpenCode (cero pasos) + instalación global (`~/.config/opencode/skills/`, `~/.claude/skills/`); 4 preguntas de ejemplo; **Uso responsable** (a la ciudadanía); aviso legal (atribución "Fuente: Gobierno de Canarias", agregadores secundarios, sin garantía); contribuir → `skills/README.md`.
- [ ] **Step 2: chequeos + commit** `docs: README raíz (uso, alcance, uso responsable, legal)`.

### Task 11: Verificación final de aceptación

**Files:** retoques posibles en ficheros ya creados.

- [ ] **Step 1: estructura y contenido**: `git ls-files` (solo ficheros publicables; `.local-mining` excluido; specs/plans se publican — decidido); grep global `/Users/`, `DATALAB_API_KEY`, términos confidenciales → vacío; secciones obligatorias en las skills nuevas; frontmatter válido en todas.
- [ ] **Step 2: test de aceptación con agente fresco**: subagente `general` nuevo con cwd = repo, sin contexto, pregunta "¿Qué contratos ha adjudicado el Gobierno de Canarias a ProSalud Sistemas (ficticio) y cuánto suman?" (límite 15 peticiones). Criterios: carga el router + datos-abiertos (o el ckan genérico si el enrutado lo lleva), cita criterio y fuente primaria con URL, distingue NIF-only (sin nombre de empresa en el dataset), y aplica al menos 2 controles de la sección adversarial (criterio explícito + cobertura). Si falla: retocar skill/AGENTS y repetir (una ronda).
- [ ] **Step 3: commit final** (ajustes) + **reporte al usuario**: commits, nº peticiones en vivo usadas, resultado del test y paso mano-obra (publicar a GitHub es manual de Juan).

## QA: qué NO está cubierto

- Datalab: receta histórica, no re-ejecutada hoy (API de pago; decisión del spec).
- DOUE/EUR-Lex (serie S): solo mención navegable; fuera del presupuesto de hoy; pendiente honesto en la skill.
- Endpoints CKAN genéricos de otras comunidades: patrón no re-verificado en vivo fuera de datos.canarias.es (la skill lo declara).
- Publicación en remote: la hace Juan a mano.
