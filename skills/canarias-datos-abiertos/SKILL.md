---
name: canarias-datos-abiertos
description: "Use when hay que consultar o descargar datos abiertos del Gobierno de Canarias (datos.canarias.es, CKAN, ISTAC, SITCAN): presupuestos, contratos, centros educativos, estadísticas de salud, listas de espera, indicadores o cualquier dataset. Imprescindible cuando una búsqueda en /api/3/action devuelve 404 o cuando hay que decidir entre API, datastore y CSV."
---

# Datos abiertos de Canarias (CKAN + ISTAC)

**Idea central:** el dominio `datos.canarias.es` **no** es un CKAN en la raíz. `/portal/` es WordPress; la API real vive en subpaths. Asume esto o te comerás un 404 y concluirás que no hay datos.

Los patrones CKAN genéricos (descubrir la ruta real de la API, datastore vs CSV, topes de filas, codificaciones) viven en la skill `ckan`; esta skill se centra en los datasets, rutas y trampas de GobCan.

## Mapa real

| Qué | URL base | Tecnología |
|---|---|---|
| Fachada editorial | `https://datos.canarias.es/portal/` | WordPress (`/wp-json/`) |
| Catálogo general (**API principal**) | `https://datos.canarias.es/catalogos/general/api/3/action` | CKAN 2.9.11 |
| Catálogo estadístico (ISTAC) | `https://datos.canarias.es/catalogos/estadisticas/api/3/action` | CKAN 2.11.4 |
| Catálogo territorial | `https://opendata.sitcan.es/api/action` | CKAN 2.10.4 |
| API REST del ISTAC | `https://datos.canarias.es/api/estadisticas/` | REST propio |

`https://datos.canarias.es/api/3/action/...` → **404**. Es el error nº 1.

## Buscar (la parte que casi todos hacen mal)

El motor aplica `mm=2`: con 1 término busca normal; con 2 exige ambos (AND); con **3+ exige solo 2** → ruido masivo. Solución: comillas o `mm=100%`.

```bash
B="https://datos.canarias.es/catalogos/general/api/3/action"

curl -sG "$B/package_search" \
  --data-urlencode 'q=lista de espera' \
  --data-urlencode 'mm=100%' \
  --data-urlencode 'rows=50' \
  --data-urlencode 'fl=name,title,organization,metadata_modified,num_resources' \
| jq -r '.result.count, (.result.results[] | [.name, .organization, .title] | @tsv)'
# → 22   (sin mm=100% ni comillas: 222)
```

- `rows=0` devuelve solo `count` (238 B). Úsalo para contar antes de descargar.
- No hay sinónimos: `sanidad` (11) ≠ `salud` (2.884). Acentos y plurales sí se normalizan.
- `defType=edismax` **rompe** la respuesta. No lo pases.
- Filtros útiles (`fq`): `organization:`, `groups:`, `res_format:CSV|XLSX|PDF`, `license_id:`, `metadata_modified:[... TO NOW]`.

## Límites duros

| Límite | Valor | Consecuencia |
|---|---|---|
| `package_search` filas/página | **1.000** (recorte silencioso) | Pagina con `start`; 24 peticiones para todo el catálogo |
| Tamaño de esa página | ~9,5 MB, **sin gzip** | Usa `fl=name,title,metadata_modified,organization` → 336 KB |
| `datastore_search` filas/página | **32.000** | Pagina con `offset` |
| `datastore_search_sql` | casts numéricos (`::numeric`) **pueden** dar 500 según columna | Si falla, agrega en cliente |
| `package_list` vs `package_search` | 23.522 vs 23.498 | No los uses para validarse entre sí |

`fl=` tiene dos efectos colaterales: `organization` pasa de objeto a string, y `fl=resources` **no** devuelve recursos. Para recursos: `package_show`.

## Datastore: consulta sin descargar el CSV

```bash
# ¿Qué recursos tienen datastore?
curl -sG "$B/package_show" --data-urlencode 'id=contratos-adjudicados-y-formalizados-del-gobierno-de-canarias' \
| jq -r '.result.resources[] | select(.datastore_active) | [.id,.format,.name] | @tsv'

# Búsqueda de texto + filtros exactos
curl -sG "$B/datastore_search" \
  --data-urlencode 'resource_id=96154b4a-5212-46c7-8bd9-36599a8165b9' \
  --data-urlencode 'q=Servicio Canario de la Salud' --data-urlencode 'limit=5' \
| jq -r '.result.total, (.result.records[] | [.entidad_adjudicadora, .importe_ofertado] | @tsv)'
# → 4940

# Agregados con SQL (ILIKE y count funcionan)
curl -sG "$B/datastore_search_sql" \
  --data-urlencode 'sql=SELECT count(*) AS n FROM "96154b4a-5212-46c7-8bd9-36599a8165b9" WHERE entidad_adjudicadora ILIKE $$%Servicio Canario%$$' \
| jq -r '.result.records[0].n'
# → 2666
```

**Todos los campos son `text`.** Ordenar `Importe desc` ordena como cadena (`8926` antes que `89224`): castea en cliente.

## ISTAC: la vía rápida para estadística sanitaria

Cubos en CSV/XLSX/JSON sin clave, versión explícita en la ruta. Para listas de espera hay **tres cubos distintos**; no los confundas:

| Cubo | Qué mide | Ejemplo |
|---|---|---|
| `C00045A_000001/1.4` | **Pacientes** en lista de espera quirúrgica (por servicio y tramo) | 3,3 MB; total Canarias `2026-M06` |
| `C00045A_000002/1.4` | **Pacientes** en lista de espera de consultas externas (por especialidad) | 538 KB |
| `C00045A_000004/1.2` | **Tasas** por 1.000 habitantes (no pacientes) | 378 KB; 2.017 filas |

```bash
# Pacientes en lista de espera quirúrgica, último periodo
curl -s "https://datos.canarias.es/api/estadisticas/statistical-resources/v1.0/datasets/ISTAC/C00045A_000001/1.4.csv" -o le_quirurgica.csv
# filtra TERRITORIO#es=="Canarias", SERVICIOS_QUIRURGICOS#es=="Total" y TIME_PERIOD_CODE más reciente
```

Columnas típicas: `TERRITORIO#es`, `TIME_PERIOD#es`, `<dimensión>#es`, `MEDIDAS#es`, `OBS_VALUE`. La versión (`/1.4`) es parte de la URL: si cambia, la ruta antigua puede seguir viva con datos viejos.

## Ficheros: encoding y formato

| Fichero | Encoding | Separador | Nota |
|---|---|---|---|
| Presupuestos (Hacienda) | **Latin-1** | `;` | decimal con coma → `iconv -f ISO-8859-1 -t UTF-8` |
| Contratos | UTF-8 (vía datastore/CSV) | `;` | 56 MB, 91.550 filas |
| SITCAN (`opendata.sitcan.es/upload/...`) | UTF-8 | `,` | muchos recursos de sanidad/educación viven aquí |

No asumas host ni separador: la `url` del recurso puede apuntar a `opendata.sitcan.es` o a `contrataciondelestado.es`. Usa `file -I` antes de parsear.

## Salud (SCS) y educación: dónde está cada cosa

No existe organización CKAN "Servicio Canario de la Salud". `consejeria-de-sanidad` solo tiene **3 datasets** (2 de COVID + DESA). Los datos operativos están en datasets horizontales:

| Pregunta | Dataset / recurso | Cómo |
|---|---|---|
| Presupuesto del SCS | `presupuestos-de-la-comunidad-autonoma-de-canarias-<año>` | `datastore_search` con `filters={"Seccion":"39"}` → 3.394 filas (2024) |
| Presupuesto de Educación | mismo dataset | `Seccion=18` → 1.086 filas (2024) |
| Contratos del SCS | `contratos-adjudicados-y-formalizados-del-gobierno-de-canarias` | 91.550 filas. **Ojo al criterio**: `ILIKE '%Servicio Canario%'` → 2.666, pero 949 son de Empleo; el literal del SCS → 1.717. Define la lista de entidades y documéntala. **No trae nombre de adjudicataria, solo `adjudicataria_nif`**: busca por NIF y resuelve la razón social en PLACSP. |
| RPT (puestos) del SCS | `relaciones-de-puestos-de-trabajo-de-la-comunidad-autonoma-de-canarias` | 14.310 filas; ~1.032 del SCS (no cubre estatutario/laboral). Es RPT, no dotación de efectivos. |
| Listas de espera | cubos ISTAC `C00045A_000001` (quirúrgica) y `C00045A_000002` (consultas) | CSV directo (arriba) |
| Centros educativos | `centros-educativos-de-canarias` | `datastore_search` → 1.469 centros, con código, municipio, isla, coordenadas. `DesEtapaCentro` es el **tipo** de centro (CEIP, IES, EEI…), no la etapa impartida |
| Enseñanzas por centro | recurso `ensenanzas-impartidas-por-centro` (`674c46cf-a087-437c-8178-087c3225e483`) | join por `Codigo`/`CodigoCentro`; un centro aparece en varias etapas (no sumes) |
| Estadística de salud | `organization:istac` + `groups:salud` (2.847) | `fq` + `mm=100%` |
| Centros sanitarios vivos | **no hay** | solo snapshot COVID 2023 y DESA |

Códigos de sección presupuestaria: **39 = SCS**, **18 = Educación, FP, Actividad Física y Deportes**. Verifica el código en la respuesta (`Descripcion Seccion`) antes de agregar; no lo hardcodees a ciegas en otro ejercicio.

`Importe` es **texto en euros** (entero, sin decimales): `tonumber` antes de sumar. Y el consolidado trae **filas duplicadas exactas** (en 2024, 27 duplicados dentro de Educación): si publicas un total, di si deduplicaste y con qué clave.

## Licencia y cortesía

Mayoría `istac-aviso-legal` / `gobcan-aviso-legal`: reutilización permitida con **atribución** ("Fuente: Gobierno de Canarias"), sin alterar el contenido. `robots.txt` del CKAN pide `Crawl-Delay: 10` y el aviso legal prohíbe saturación: **1 petición cada 1–2 s**, cachea en local. No hay rate limit observable, pero eso no es permiso para martillear.

## Trampas

| Síntoma | Realidad |
|---|---|
| `/api/3/action/...` → 404 HTML | Falta `/catalogos/general`. |
| `rows=5000` devuelve 1.000 | Recorte silencioso, sin aviso. |
| `count` bajo con 3+ palabras | `mm=2`. Añade `mm=100%`. |
| `.organization.title` revienta con `fl=` | Con `fl`, `organization` es string. |
| `include_datasets=true` sin `resources` | Hay que hacer `package_show` por dataset. |
| `size: null` | Normal en ISTAC; no lo uses para decidir. |
| `metadata_modified` reciente en datos de 2020 | El cosechador toca fechas. Comprueba el periodo dentro del dato. |
| `sum(importe::numeric)` → 500 | Puede fallar según columna; si es así, agrega en cliente. En contratos, `sum(importe_ofertado::numeric)` sí funciona. |
| `datastore_active: true` pero `datastore_search` da `success: false` | Pasa en el dataset de contratos de 2019. Baja el CSV o usa la serie 2020+. |
| Buscar el proveedor por su nombre en `objeto_contrato` | El objeto nombra el producto (la suite contractuada), no al fabricante. Busca por NIF. |
| Producto = proveedor | Falso: el mismo producto lo mantienen varios proveedores distintos. Filtra por NIF y usa el CPV para ver el ecosistema, pero no sumes mantenimiento con licencias. |
| `contrataciondelestado.es` y `ted.europa.eu` rechazan `curl` | El **sitio web** sí (000). La **API TED v3** no: `POST https://api.ted.europa.eu/v3/notices/search` con `{"query":"publication-number=<n>","fields":[...]}` responde JSON, y el XML del anuncio está en `https://ted.europa.eu/en/notice/<n>/xml`. |
| NIF raros (valores generalizados: `**...**`, `12345...`) | Hay valores corruptos en `adjudicataria_nif`; un join por NIF puede fallar en silencio. Valida el formato (letra + 8 dígitos). |
| `q=` y `filters=` discrepan en 1 fila | `q` es full-text y arrastra ruido. Para secciones presupuestarias usa `filters` exacto. |
| `DesEtapaCentro` parece la etapa | Es el **tipo** de centro. La etapa impartida está en otro recurso (`ensenanzas-impartidas-por-centro`). |
| `ILIKE '%Servicio Canario%'` parece el SCS | Incluye ~949 contratos del Servicio Canario de **Empleo**. |
| "Plantilla del SCS" no aparece como dataset | Sí hay **RPT** (puestos). No hay dotación de efectivos: no lo confundas ni mandes a SAIP sin comprobar la RPT. |
| El total del presupuesto no cuadra al sumar | Hay filas duplicadas exactas y `Importe` es texto. Deduplica y documenta la clave. |
| CSV de presupuestos con `Ã³` | Latin-1. Convierte antes de parsear. |

## Antes de dar un dato por bueno

1. `count` primero, `rows` después.
2. Compara el `count` con las filas que has traído; si difieren, pagina.
3. Guarda `name` del dataset, `id` del recurso, URL y fecha de consulta.
4. Distingue fecha del dato (`TIME_PERIOD`) de fecha de metadato (`metadata_modified`).
