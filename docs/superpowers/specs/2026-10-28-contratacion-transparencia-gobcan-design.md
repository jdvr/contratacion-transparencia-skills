# Diseño: repo `contratacion-transparencia-skills` — habilidades de contratación pública y transparencia

El repo nace llamado `transparencia-gobcan-skills` y se renombra a `contratacion-transparencia-skills` (decisión 2026-10-28: quitar "canarias" del título, acoger skills de otras comunidades autónomas y tratar CKAN como plataforma genérica). Fecha: 2026-10-28 · Autor: sesión GLM-5.3-Flash con Juan Vega · Estado: aprobado

## 1. Intención y por qué

Preparar un repositorio público listo para usar: cualquiera lo clona (o apunta su agente OpenCode hacia él) y puede hacer preguntas sobre contratación pública y transparencia — PLACSP (contrataciondelestado.es), anuncios del DOUE/TED, portales de datos abiertos (CKAN) y transparencia autonómica — y el agente responde con los flujos de trabajo, trampas y disciplina de verificación ya validados en las sesiones de análisis de Juan.

**Tres capas** (decisión 2026-10-28):
1. **Genérica de plataforma** — válida en cualquier ámbito: `placsp` (toda España), `doue-ted` (UE) y `ckan` (patrones CKAN reutilizables; CKAN es el software libre que sostiene datos.gob.es y muchos portales autonómicos). Nacen de la experiencia canaria, con vocabulario genérico y ejemplos canarios verificados.
2. **Capa autonómica** — las skills `canarias-*` portadas tal cual, muy contrastadas (GobCan). El repo acepta skills para otras comunidades con la convención de nombres `<comunidad>-*` (p. ej. `andalucia-datos-abiertos`); `skills/README.md` fija la convención.
3. **Enrutado** — `AGENTS.md` y el playbook eligen capa por origen del órgano/portal: órgano/portal canario → capa Canarias; otro ámbito español → PLACSP (+ CKAN genérico si el portal lo es); anuncio europeo → DOUE/TED. El README lo explica para público humano; nada se reescribe para esconder que nació en Canarias.

No es una aplicación: es material para agentes (skills + AGENTS.md + ejemplos verificados).

## 2. Objetivos / no-objetivos / anti-objetivos

**Objetivos**

- Clonar y usar: `git clone`, abrir OpenCode en el repo, preguntar "¿qué contratos ha adjudicado el SCS a ProSalud Sistemas (ficticio)?" y que el agente cargue la skill correcta y responda con cifra + criterio + fuente verificada.
- Incluir las 3 skills canarias existentes (`canarias-datos-abiertos`, `canarias-transparencia-portal`, `canarias-datos-publicos-playbook`) como punto de partida verificado.
- Crear 2 skills nuevas a partir de los patrones extraídos de las sesiones: `placsp` y `doue-ted`.
- Un AGENTS.md raíz que enruta por tarea ("empieza aquí") y que conecta los cuatro ecosistemas (GobCan datos, GobCan transparencia, PLACSP, DOUE/TED).
- Todo el contenido en **español** (institución española), con fragmentos exactos (URLs, comandos, tokens) tal cual verificados.

**No-objetivos**

- No incluir datos personales ni material confidencial de las sesiones (todo lo que va al repo es público o fue publicado por fuentes oficiales).
- No automatizar presentaciones ni solicitudes SAIP (requieren certificado; el agente debe saber que no es automatizable y traspasar a la persona).
- No escribir scripts de extracción masiva: las skills documentan recetas puntuales verificadas, no crawlers.

**Anti-objetivos (fallo aunque el repo "funcione")**

- Un agente que responde sin criterio de selección ni fuente primaria — el "contrato de evidencia" de las sesiones debe ser cultura del repo.
- Concluir "no hay datos" a partir de un 404 o de una vista JS (patrón de error n.º 1 documentado de este dominio).

## 3. Restricciones

- SKILL.md necesita frontmatter YAML (`name`, `description` estilo "Use when..." en español) y es la superficie de enrutado: la description debe contener los disparadores y las señales de fallo conocidas.
- OpenCode descubre skills en `.opencode/skills/` o en directorios declarados en la clave `skills` de la configuración; también carga `AGENTS.md` automáticamente. Claude Code sincroniza desde `~/.claude/skills/`; se documentará cómo instalar globalmente.
- Cada skill lleva marca de verificación ("Verificado: 2026-10" + qué probé) porque los endpoints se pudren (ya ocurrió: buscador global del portal roto, CSV truncado).
- Respeto a robots.txt y límites documentados (`Crawl-Delay: 10`, topes de filas) deben quedar dentro de las skills, no solo en AGENTS.md.

## 4. Enfoques considerados

1. **Híbrido (elegido)** — `skills/` como fuente de verdad visible y navegable; el `opencode.jsonc` del repo declara `"skills": ["./skills"]` para descubrimiento zero-config en OpenCode; README explica cómo instalar en `~/.config/opencode/skills` o `~/.claude/skills` para uso global. *A favor: legible por humanos, agnóstico del cliente, un solo sitio de verdad. En contra: una línea de configuración.*
2. **Solo `.opencode/skills/`** — cero configuración para OpenCode, pero skills ocultas para quien navega el repo y copia manual para otros agentes. *Descartado.*
3. **Paquete con `install.sh`** que rsynca a directorios globales — buena ergonomía personal, pero añade una pieza que mantener y rompe el flujo clonar-y-usar. *Descartado.*

## 5. Estructura del repo (lo decidido)

```
contratacion-transparencia-skills/
├── AGENTS.md                    # router "empieza aquí por tarea" + contrato de evidencia (ES)
├── README.md                    # humano: de qué va, clonar, tabla de skills, legal
├── opencode.jsonc               # ya existe: + "skills": ["./skills"]
├── skills/
│   ├── README.md                # índice de skills + reglas para añadir una nueva
│   ├── placsp/                  # NUEVA (estatal, cualquier órgano español)
│   │   └── SKILL.md
│   ├── doue-ted/                # NUEVA (DOUE serie S = TED, UE)
│   │   └── SKILL.md
│   ├── ckan/                    # NUEVA (patrones CKAN genéricos)
│   │   └── SKILL.md
│   ├── canarias-datos-abiertos/SKILL.md          # portada verbatim + nota de enlace a `ckan`
│   ├── canarias-transparencia-portal/SKILL.md    # portada verbatim
│   └── canarias-datos-publicos-playbook/SKILL.md # portada + router actualizado
├── examples/
│   ├── ejemplo-proveedor-por-nif.md      # transcripto verificado (ejemplo con datos generados)
│   └── ejemplo-cadena-de-contratos.md # cadena 2013→futuro con fuentes y criterios (datos generados)
└── docs/superpowers/specs/            # este documento + plan
```

## 6. Contenido de las piezas (lo que cada una debe contener)

Todas las skills — nuevas y portadas — deben incluir el flujo de **revisión adversarial y controles de calidad de la §9**; es un requisito de aceptación, no una sugerencia.

### 6.1 `skills/placsp/SKILL.md` (nueva — minada de 5 sesiones)

Alcance **estatal**: PLACSP es la plataforma de toda España; la skill se escribe para cualquier órgano de contratación, con ejemplos canarios (SCS) como casos verificados.

Frontmatter "Use when": expedientes, licitaciones, adjudicaciones, contratos del Gobierno de Canarias / SCS; señales de fallo explícitas (curl bloqueado, búsqueda del portal débil, tokens).

- **Idea central**: PLACSP no es API-first; la "gramática" de navegación es websearch/agregador → ficha deeplink con `idEvl` → documento (GetDocumentByIdServlet o UUID dentro del cuadro de características) → verificación en fuente primaria. Nunca confiar solo en agregadores.
- **Mapa real** (tabla URL base ↔ qué devuelve): `wps/poc?uri=deeplink:detalle_licitacion&idEvl=<token>`; servlet de documentos; wcm `docAccCmpnt` con `DocumentIdParam` UUID. Tokens son opacos y hay que copiarlos URL-encoded (`%2F`, `%2B`, `%3D`) intactos. `contrataciondelestado.es` rechaza `curl` (código 000) → usar `webfetch`/navegador.
- **Recetas**: de noticia a expediente (importe+fecha → primaria → ficha); retro-cronología con BOE (`boe.es/diario_boe/txt.php?id=BOE-B-AAAA-NNNNN`); descarga de pliegos; y la receta de **PDF de pliegos → markdown con Datalab** (recuperada del histórico, verificada en `uned-pecs` / contexto de pliegos):
  - CLI local: `datalab convert --format markdown <fichero.pdf>` — sube el PDF a `POST https://www.datalab.to/api/v1/convert`, sondea y guarda el `.md` junto al original. Requiere `DATALAB_API_KEY` en el entorno (nada de keys escritas en ficheros).
  - Vía URL: la misma API acepta `file_url` (ingesta directa de un PDF por URL) y devuelve `request_check_url` para el sondeo; útil cuando la ficha PLACSP entrega PPT/PCAP en `application/pdf` y `webfetch` no los puede leer.
  - Trampa documentada (de sesión real): si el entorno Python tiene `brotlipy` encima del módulo `brotli`, la respuesta br comprimida por Cloudflare falla con `ClientPayloadError 400 "Can not decode content-encoding: br"`; arreglo: borrar el paquete `brotli/` viejo (y el egg-info de brotlipy, sin dist-info no hace `pip uninstall`) + `pip install -U Brotli`.
  - Regla de uso: conversión punto-a-punto de documentos citados (no crawlers; la API es de pago y atribuye llamadas). El md resultante se relee con `grep`/`read` por secciones para citar cláusulas con artículo/página ("PCAP, cláusula 28.2.2" — ejemplo).
- **Trampas** (tabla síntoma→realidad, ≥15 filas del minado): expedientes renumerados por año; letra A/N que cambia en tramitación; pliego anulado y repuesto; el "Pliego" de la ficha puede ser el cuadro de características; fichas pre-adjudicación ("licitado"); CSV del portal de transparencia truncado a 60.000 filas alfabéticamente; producto ≠ proveedor (el producto (ficticio) lo mantienen 4+ empresas); adjetivos de importe (adjudicado vs estimado vs presupuesto base, con/sin IGIC, anualidad vs plurianual).
- **Contrato de evidencia** (7 ítems, del playbook) + nomenclatura de expedientes (`19/T/AA/SS/CO/A|N/NNNN`) + registro de tokens `idEvl` conocidos con su expediente.
- **Verificado: 2026-10** (fichas reales del órgano verificadas en vivo (expedientes concretos no publicados en el repo)).

### 6.2 `skills/doue-ted/SKILL.md` (nueva)

Alcance **europeo** (DOUE / TED: cualquier comprador de la UE, con contraste del caso español verificado).

Frontmatter "Use when": DOUE, TED, anuncios en el Diario Oficial de la UE, modificaciones de contrato, cifras en `PayableAmount`.

- **Idea central**: la web de TED bloquea `curl` pero la **API v3 sí responde**: `POST https://api.ted.europa.eu/v3/notices/search` con JSON `{"query": ..., "fields":[...], "limit":N}`; si el campo pedido no existe, el error devuelve los válidos (descubrimiento por mensaje). Fallback XML: `https://ted.europa.eu/en/notice/<n>-<año>/xml` y grep `cbc:*Amount` / `PayableAmount`. Las fichas PLACSP llevan el número TED del anuncio (puente expediente↔notice verificado en sesión; los números TED concretos no se publican aquí)).
- **Vínculo DOUE**: el DOUE serie S (contratos por encima de umbrales) se publica vía TED; *Añadido pendiente*: en la fase de construcción se hará una verificación en vivo (rerunning URLs y syntaxis) de los endpoints actuales de DOUE/TED y se fijarán en la skill con marca "Verificado".
- Trampas: páginas detalle con `webfetch` fallan; rutas antiguas de versiones de cubo/notice siguen vivas con datos viejos; paginación y límites de la API.

### 6.3 Las 3 skills canarias — portadas y una actualización

- Se copian `verbatim` desde `~/.claude/skills/` (son el activo validado: baseline 19 peticiones contra 8 con skills; 4 errores detectados y corregidos en su validación).
- Única modificación: `canarias-datos-publicos-playbook` (el router) extiende su tabla de enrutado con las dos skills nuevas: "cifra agregada de contratos → CKAN (skill `canarias-datos-abiertos`)"; "expediente/pliego/anuncio concreto → PLACSP (skill `placsp`)"; "modificación o anuncio en DOUE/TED → skill `doue-ted`".

### 6.4 `AGENTS.md` raíz (nuevo)

- **"Empieza aquí por tarea"** (patrón langfuse, en español): tabla frase-disparador → skill a cargar (p. ej. "¿cuánto ha gastado el SCS en X? → playbook + datos-abiertos"; "¿dónde está el expediente 19/T/24/...? → placsp"; "¿ha modificado el contrato? → doue-ted").
- **Contrato de evidencia** en 7 ítems, todo en español, a los 2 primeros párrafos para que el agente lo lea antes que nada.
- **Legalidad y buen ciudadano (robots.txt, límites, atribución)**.
- **Uso responsable** (añadido 2026-10-28): estos portales son un servicio público mantenido con fondos públicos para toda la ciudadanía; un uso abusivo (crawling masivo, peticiones agresivas, reintentos encadenados) degrada el servicio para todos. Regla de repo: presupuesto de peticiones declarado y respetado, espera entre peticiones, nunca scrapeo masivo cuando sirven CSV/API oficiales, cachear localmente lo ya descargado antes de pedirlo otra vez, y preferir siempre la vía documentada (API/CSV) a la improvisación. Un agente de este repo es *ciudadano*, no crawler.
- Un párrafo "Método de trabajo": presupuesto de peticiones, `sleep` entre peticiones, tabla de reparto subagentes → domains.

### 6.5 `README.md` (nuevo)

- De qué va + tabla de skills (nombre, para qué, verificado en fecha).
- **Aviso de alcance** (decisión 2026-10-28): el repo nace de la experiencia con el Gobierno de Canarias, pero las skills `placsp` y `doue-ted` funcionan para **cualquier órgano de contratación de España y de la UE** — los flujos y trampas son de plataforma, no de Canarias; los ejemplos canarios solo ilustran la capa autonómica.
- "Uso": (a) clonar y apuntar OpenCode → cero pasos; (b) o `cp`/rsync de `skills/*` a `~/.config/opencode/skills/` (OpenCode global) o `~/.claude/skills/` (Claude Code).
- "Preguntas de ejemplo" (3-4 del vaivén real de Juan).
- Aviso legal: los datos son públicos, la atribución es exigencia del aviso legal del portal; los agregadores son fuente secundaria; hay que verificar en primaria.
- **Uso responsable**: lo mismo en clave humana — estos servicios son para toda la ciudadanía; el repo no servirá para crawlers ni para explotar las plataformas (presupuestos, espera, no-mass-scraping), y así se dice en el README con la misma claridad que en las skills.

### 6.6 `skills/README.md` (índice)

Tabla de skills con "Uso para:" + checklist "añadir una nueva skill" (frontmatter, volver a verificar contra la fuente, tabla de trampas obligatoria, marca de verificación) — patrón langfuse traducido y adaptado al estilo canarias.

### 6.7 `examples/` (nuevo)

Dos transcriptos verificados, en la forma *tarea → comandos → resultado → fuentes*, editados de los transcriptos de sesión:
1. **El proveedor de ejemplo (datos generados) por año y concepto** — buscar pagos/contratos por NIF en CKAN, arreglo de criterios (ILIKE, `sum(importe_ofertado::numeric)`), resultado con criterio explícito.
2. **Cadena de contratos ficticios 2013→2026** (empresa ficticia de la sanidad) — saga completa: pliegos → fichas PLACSP → BOE → TED → agregadores, con columnas Periodo/Expediente/Importe/Adjudicataria/Fuente y etiquetas [VERIFICADO]/[HIPÓTESIS]/[PENDIENTE].

Redacción: solo fuentes públicas (reales no publicadas: los ejemplos usan datos generados; nada del material confidencial del proyecto de quejas de la app del SCS.

## 7. Qué queda a decisión del constructor (fase de implementación)

Decidido tras el builder-check (2026-10-28):

- **Licencia y publicación**: CC BY 4.0 para el contenido (coherente con el aviso legal del portal, que exige atribución). Se hace `git init` + LICENSE en este repo; la publicación en remote (GitHub) la hace Juan a mano después de revisar.
- **`opencode.jsonc` del repo queda limpio**: solo `"$schema"` + `"skills": ["./skills"]`. Las reglas de permisos de lectura de `<workspace propio>` (personal) se mueven a la config global `~/.config/opencode/` para que el acceso local de Juan no se pierda y nada personal se publique.
- **Fuente canónica**: el repo. Tras portar, se sincroniza la misma actualización del router en la copia local `~/.claude/skills/canarias-datos-publicos-playbook/SKILL.md`.
- **Material minado**: `.local-mining/sesiones/*.md` (11 transcriptos, excluido del control de versiones) y `.local-mining/informes-extraccion.md` (digesto A/B/C); ficheros resultantes ya escritos por Juan en `<workspace propio>` (`dossier-unificacion.md`, ...), solo lectura.
- **Verificación en vivo**: TED/DOUE/PLACSP se re-verifican en vivo con un presupuesto peticiones pequeñas (~15) y fecha anotada. La receta Datalab NO se re-verifica (API de pago) — se conservan los hechos de la mina (comando exacto, host, `file_url`, `request_check_url`, trampa brotli) con el marcaje histórico "Verificado: 2026-10 (de sesiones, no re-ejecutado hoy)". No se entra en `uned-pecs`; los hechos ya están extraídos aquí.
- **Estructura del playbook**: un único `SKILL.md`, al estilo canarias. El árbol que mostraba un apartado extra era ruido tipográfico.
- **Patrón de nombres** (decisión 2026-10-28): las skills autonómicas siguen exactamente `[comunidad]-[plataforma]` (dos elementos kebab-case: `andalucia-transparencia-portal`); las genéricas de plataforma llevan solo el nombre (`placsp`, `doue-ted`, `ckan`); el playbook autonómico es `<comunidad>-datos-publicos-playbook`.
- **Mantenimiento** (decisión 2026-10-28): skill `mantenimiento` (meta-skill con la rutina: cómo añadir/actualizar/verificar/sincronizar/retirar) + agente `mantenedor` declarado en `opencode.jsonc` (mode subagent, permissions específicas sobre skills/, AGENTS.md, examples/, docs/ y las carpetas globales de sincronización `~/.claude/skills` y `~/.config/opencode/skills`).
- **Reflow de prosa** (decisión 2026-10-28): sin saltos de línea manuales en el markdown de prosa (un párrafo/frase por línea); el wrap se hace en el render. Vallas de código, tablas, frontmatter y títulos conservan formato.
- **Instalación con el ecosistema `npx skills`** (decisión 2026-10-28): el repo debe ser instalable con `npx skills add <owner>/<repo>` (skills.sh, soporta OpenCode entre otros ~20 agentes). La estructura `skills/<nombre>/SKILL.md` ya es compatible: el CLI descubre los SKILL.md recursivamente tras publicarse en GitHub. Los dos caminos de instalación (npx skills / clonar-y-usar) quedan documentados en el README con su diferencia: npx instala skills en un agente; clonar además da el AGENTS.md, ejemplos y el agente `mantenedor`.

## 8. Criterios de aceptación

1. `git clone` en una máquina limpia + OpenCode apuntando al repo: un agente nuevo, sin contexto previo, puede responder las 4 preguntas-ejemplo del README citando criterio y fuente primaria.
2. Cada skill nueva tiene frontmatter, tabla de trampas, recetas con comandos copy-pasteables verificados, marca "Verificado" **y la sección de revisión adversarial de la §9**.
3. Nada de material confidencial de <workspace propio>; solo fuentes públicas.
4. El flujo de `~/.claude/skills` de Juan sigue funcionando igual de bien después del repo (no se rompen sus skills locales).
5. Español en toda la prosa; inglés solo en código / headers HTTP / nombres de campo.

## 9. Revisión adversarial y controles de calidad (transversal, obligatoria)

Requisito añadido por Juan (2026-10-28): las skills no solo dicen *cómo buscar*, sino
* cómo asegurar que lo encontrado es correcto*, con pasos de control dentro del flujo y una revisión adversarial estructurada antes de entregar cualquier cifra. Nace de la metodología ya validada (baseline 19 peticiones con 404 y suspendidas vs GREEN 8 peticiones; validación adversarial que encontró y corrigió 4 errores de skill).

**9.1 Controles dentro del flujo** (checkpoint en cada receta, atajo "control:"):
1. **Contar antes de creer**: filas traídas vs total declarado por la fuente (la ficha declara "212.173"; CKAN devuelve el count). Si difieren, decir por qué.
2. **Segunda fuente**: toda cifra sensible se contrasta con una fuente lógicamente distinta (CKAN ↔ CSV del portal de transparencia; PLACSP ↔ BOE ↔ TED ↔ cifras de la Cámara de Cuentas). Registro de la discrepancia si la hay (el CSV del portal está truncado: se espera que discrepe y se dice cuánto).
3. **Comprobar el contenedor**: content-type, codificación (Latin-1 vs UTF-8), delimitador, y que el dato no venga de una vista JS o de un error con código 200.
4. **Criterio explícito**: qué filas entran (ILIKE '%Servicio Canario%' ≠ SCS; 2.666 vs 1.717 es la diferencia documentada). Nunca publicar un total sin su criterio.
5. **Aritmética por script** antes de publicar sumas (`node -e` / python), un solo criterio, sin doble conteo (comprobar lotes y UTE).

**9.2 Revisión adversarial antes de entregar** (checklist "intenta falsificar tu propia cifra"):
1. Recalcular con una query *distinta* (GROUP BY entidad_adjudicadora, filtro inverso, rango temporal más ancho): ¿surge un número compatible? Si no, explicar la diferencia.
2. Buscar el contraejemplo: ¿hay filas que el criterio excluye injustamente? (elegir una exclusión y verificarla).
3. ¿La skill misma miente? (patrón validado: "¿qué dato de esta skill es incorrecto o está desactualizado?", como pidió el test GREEN original). Fechas de actualización vs hoy.
4. **Cobertura declarada**: qué se buscó, qué no, con qué presupuesto de peticiones.
5. Etiquetas honestas: VERIFICADO / HIPÓTESIS / PENDIENTE / NO CONCLUYENTE (con el motivo). "No encontrado" honesto > cifra inventada.

**9.3 Adversarial de la skill en sí (pre-publicación)**: cada skill nueva debe haber sobrevivido a un test con agente fresco sin la skill (línea base) y con la skill (GREEN), más una pasada de validación adversarial como las del 2026-10 (4 errores detectados y corregidos). Los errores y correcciones quedan anotados en el commit o en `skills/README.md`. El checklist "añadir una skill" (`skills/README.md`) lo exige.

**9.4 Dónde vive**: cada SKILL.md nueva añade la sección "Controles y revisión adversarial" (resumida, con los checkpoints relevantes a su dominio y referencias concretas); `AGENTS.md` la presenta en su marco (obligatoria, "antes de dar cualquier cifra"). Las skills canarias portadas ya llevan su checklist equivalente ("Antes de dar un dato por bueno"); no se reescriben, se respeta su formato.
