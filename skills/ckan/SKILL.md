---
name: ckan
description: "Use when un portal de datos abiertos usa CKAN (software genérico: datos.gob.es, datos.canarias.es, open data autonómicos o europeos) y hay que descubrir la API real, buscar datasets, descargar o consultar recursos (datastore/SQL/CSV). Imprescindible cuando `/api/3/action` en la raíz del dominio devuelve 404, cuando un `datastore_active: true` no responde, o cuando los topes de filas y las codificaciones no cuadran."
---

# Portales de datos abiertos con CKAN (genérico, instancia: datos.canarias.es)

**CKAN es software libre de portales de datos: el mismo patrón vale en cualquier portal que lo use (datos.gob.es, varios portales autonómicos, UK, Canadá...).** La idea central: **la API casi nunca está en la raíz del dominio** — vive bajo una ruta de catálogo, y cada portal la pone donde quiere. El error n.º 1 es atacar `https://portal.gov/api/3/action/...` y dar por muerto el portal con un 404 que es cuestión de ruta. Segunda idea: dataset ≠ resource ≠ datastore. El dataset es la ficha; el resource es el fichero; el datastore es la tabla PostgreSQL consultable de ese resource. Y tercera: `datastore_active: true` **puede mentir**.

*Instancia contrastada: datos.canarias.es — API en `https://datos.canarias.es/catalogos/general/api/3/action` (CKAN 2.9.11) y catálogo estadístico en `/catalogos/estadisticas/` (CKAN 2.11.4). El portal editorial (`/portal/`) es otro sistema (WordPress) y no es la API.*

## Mapa real (patrón genérico → qué devuelve)

| Llamada | Patrón | Nota |
|---|---|---|
| Descubrir API | `GET <catalogo>/api/3/action/status_show` | ¿200 JSON? → ésta es la ruta viva. Anota la versión de CKAN: cambios mayores entre 2.9 y 2.11 son significativos |
| Búsqueda | `package_search` | params `q`, `fq`, `rows` (tope 1.000), `start`, `sort`, `fl` |
| Ficha | `package_show?id=<slug>` | trae `resources[]` con `format`, `datastore_active`, URLs |
| Datastore | `datastore_search` | tope 32.000 filas/página; `filters`, `q`, `fields`, `sort`, `offset` |
| SQL | `datastore_search_sql` | SQL sobre la tabla del resource; puede fallar por columna |
| CSV | URL de `download/...` del resource | a menudo con redirect; codificación y `;` no garantizados |
| RDF/DCAT | `<catalogo>/dataset/<slug>.rdf` | metadatos legibles si el portal lo sirve |

En zsh: `curl -sG "<ruta>/api/3/action/package_search" --data-urlencode 'q=...' --data-urlencode 'rows=5'` (sustituye `<ruta>` por la ruta viva de la receta 1). Para SQL con comillas, dollar-quoting: todo el SQL entre comillas simples y los literales `$$texto$$`; si lo pones entre comillas dobles, `$$` se interpreta como el PID del shell (fallo real observado en esta misma construcción).

## Recetas

1. **Descubrir la ruta de la API**: probar `status_show` en las rutas candidatas (`/api/...`, `/catalogos/<algo>/api/...`, subdominio de opendata). El 404 con HTML "Documento no encontrado" significa ruta equivocada, no portal muerto.
2. **Buscar con intención**: contadores primero (`rows=0`), luego la ficha (`package_show`) y inspect de `resources` (format, size, `datastore_active`). `fq=organization:X`, `fq=res_format:CSV`, `fq=groups:salud` filtran mejor que cadenas sueltas en `q`. `mm=100%` fuerza AND en Solr; sin él, el matching es laxo.
3. **Count exacto**: `datastore_search` con `filters={"Campo":"valor"}` y `limit=0` devuelve el total; SQL con `count(*)` para lo que `filters` no expresa.
4. **Agregaciones**: `datastore_search_sql` con `sum(columna::numeric)`, `GROUP BY`, ranges. Si una columna tira 500, agrega en cliente bajando CSV.
5. **Descargar CSV**: `curl -sSL '<resource url>/download/...'`; normaliza codificación (`iconv -f ISO-8859-1 -t UTF-8`) y delimitador antes de parsear.

## Trampas

| Síntoma | Realidad |
|---|---|
| `/api/3/action` en la raíz → 404 HTML | La API vive bajo ruta de catálogo; localízala con `status_show` en candidatos |
| `datastore_active: true` pero `datastore_search` falla con `success:false` | El flag puede mentir; solo queda bajar el CSV |
| "Devuelve 10 resultados" | Es el default de `rows`; pon el que quieras (tope 1.000 en `package_search`) |
| `limit=100000` en datastore | Se acepta pero recorta a 32.000; pagina con `offset` |
| `sum(col::numeric)` → 500 | Falla según el tipo real de la columna; agrega en cliente |
| Muchos resultados por sinónimos/plural | Solr para algo del texto; `mm=100%` o frase entre comillas estrecha |
| CSV con acentos rotos | Codificación Latin-1/ISO-8859-1 habitual en España; `iconv` o `encoding='latin-1'` |
| Search con `q=` da 1 fila más/menos que `filters=` | Ruido full-text; para números exactos usa `filters` |
| API "sin límite aparente" | `robots.txt` suele vetar `/api/` con `Crawl-Delay`; pide despacio y por bien |
| Versión en la ruta de datos (ISTAC, cubos) | Rutas antiguas siguen vivas con datos viejos; nota la versión que consultas |

## Controles y revisión adversarial (obligatorios antes de dar un dato por bueno)

1. **Contar**: filas traídas vs `count` declarado (o "Se han encontrado N resultados"). Discrepancia → explicar la causa (tope, truncado, tu filtro).
2. **Segunda fuente**: la misma cifra desde una vía lógicamente distinta (otro resource, otro formato, un CSV, una tabla HTML del portal). Discrepancias esperables se dicen con su motivo, no se esconden.
3. **Contenedor**: verifica content-type real y codificación; no creas datos de una página de error con código 200.
4. **Criterio del total**: cualquier agregación lleva un criterio explícito ("suma de entidad X y año Y"); nunca suma "de todo" sin decidir el criterio primero.
5. **Adversarial**: intenta falsificar tu cifra con una query distinta (GROUP BY, filtro inverso, rango mayor); declara cobertura (qué buscó y qué no); etiqueta VERIFICADO / HIPÓTESIS / NO CONCLUYENTE. Comprueba si esta misma skill está desactualizada con `status_show` (la versión te lo dice).

**Verificado: 2026-10-28 en datos.canarias.es (CKAN 2.9.11 general, 2.11.4 estadístico). El patrón genérico no está re-verificado en otros portales: al usarlo fuera, corre `status_show` primero y actualiza esta skill con tu instancia.**

Antes de dar un dato por bueno: URL/comando exacto, dataset + resource id, criterio, fecha del dato (≠ `metadata_modified`), filas vs count, bandera de parcialidad, licencia y atribución.
