---
name: canarias-transparencia-portal
description: "Use when hay que extraer información del Portal de Transparencia del Gobierno de Canarias (gobiernodecanarias.org/transparencia): presupuestos, contratos, retribuciones, plantillas, convenios, normativa, listas de espera o cualquier ficha de publicidad activa. Cubre salud (SCS) y educación. También when una URL /transparencia/temas/... debe convertirse en datos o documentos descargables."
---

# Portal de Transparencia de Canarias

**Idea central:** el portal es HTML renderizado en servidor con rutas semánticas estables. El buscador global está roto. Se navega por **índice → ficha → enlace**, nunca por búsqueda ni adivinando URLs de documentos.

## Arranque: 3 peticiones que valen más que cualquier buscador

```bash
BASE=https://www.gobiernodecanarias.org

# 1) Mapa del sitio de facto: ~1.150 enlaces con texto de ancla (490 KB)
curl -s "$BASE/transparencia/mapa-web/" -o mapa.html
grep -oiE '<a[^>]*href="[^"]*"[^>]*>[^<]+</a>' mapa.html | grep -i 'presupuest\|contrato\|retribu\|espera'

# 2) Índice de las ~167 fichas de publicidad activa, en una petición
curl -s "$BASE/transparencia/buscador-metadatos/?export=true" -o meta.html

# 3) (fallback limpio) el mismo índice paginado, 10 por página, 17 páginas
curl -s "$BASE/transparencia/buscador-metadatos/?pagina=1"
```

Al parsear el export, **arregla el bug**: 166 de 174 URLs salen como `.orgt/` en vez de `.org/`.

```bash
sed -i '' 's/\.orgt\//.org\//g' meta.html     # macOS
# sed -i 's/\.orgt\//.org\//g' meta.html      # GNU
```

## Gramática de URLs

```
/transparencia/                                    home
/transparencia/temas/<area>/<subarea>/<materia>/   ficha de publicidad activa
/transparencia/destacados/<slug>/                  landing temática (p.ej. por-temas/educacion)
/transparencia/mapa-web/                           árbol completo
/transparencia/buscador-metadatos/                 índice de fichas (server-side)
```

Seis áreas de primer nivel: `institucional-organizativa`, `economica-financiera`, `accion-gobierno-normativa`, `contratos-convenios-subvenciones`, `servicios-procedimientos`, `derecho-de-acceso`.

Rutas en inglés, contenido en español, estables desde hace años. Los documentos **no** siguen patrón: cuelgan de `/cmsgob1/export/sites/<ruta-espejo>/doc/<nombre>.<ext>`. Usa el `href` íntegro; el texto del ancla a veces está truncado con `…`.

## De una tabla dinámica al CSV completo

Cualquier tabla paginada del portal expone un `contentId` en un formulario oculto. Con él, `descargaCSV.jsp` sirve el export por **GET, sin cookie ni token**:

```bash
FICHA="$BASE/transparencia/temas/contratos-convenios-subvenciones/contratacion-y-concesion-servicios/actividad-contractual/formalizados/"
CID=$(curl -s "$FICHA" | grep -o 'name="contentId" value="[^"]*"' | head -1 | cut -d'"' -f4)

curl -s "$BASE/transparencia/descargaCSV.jsp?contentId=$CID&buscar=Buscar" -o datos.csv
```

Ejemplo verificado: contratos → `contentId=8001c7f7-d72a-11ea-8be7-6717373e7cdd`, 25,7 MB, 60.000 filas, UTF-8, separador `;`.

Parseo obligatorio con librería CSV (hay `;` y saltos de línea dentro de comillas):

```python
import csv
rows = list(csv.DictReader(open('datos.csv', encoding='utf-8', newline=''), delimiter=';'))
```

Respaldo cuando el CSV no basta: la misma ficha pagina en HTML con `?pagina=N` (10 filas/página) y ordena con `?order=<nº columna>,ASC`. Los filtros por campo también van por query: `?0=hospital&buscar=Buscar`.

## Documentos

- Los PDF son **nativos** (texto extraíble con `pdftotext -layout`), no escaneados.
- Hay XLSX/ODS reales, a menudo en `doc/formatoreutilizable/`.
- `robots.txt` incluye `Disallow: /*.pdf$` en el grupo `User-agent: *`. Es una política anti-crawling, no una prohibición de descarga puntual; **la decisión es del operador humano**. No rastrees PDFs en masa ni lo ignores en silencio: descarga solo los documentos que la tarea justifique, o pide al humano el lote.
- No hay `sitemap.xml`, ni API REST, ni `ETag`. `Last-Modified` siempre es "ahora": no sirve para polling; compara contenido normalizado.

## Trampas (todas verificadas)

| Síntoma | Realidad |
|---|---|
| `/buscador/search?query=...&ambitos=transp` tarda 60 s y da 503 | Endpoint roto. No es una caída del portal. Usa mapa-web o buscador-metadatos. |
| La ficha dice "Formato: HTML" pero no hay tabla | Enlace a CMS legacy (`contenidoGenerico.jsp`) que devuelve **500**. Marca el dato como no disponible. |
| `?export=true` da URLs `.orgt/` | Bug del portal. Aplica el `sed`. |
| La tabla devuelve 200, filas válidas y un banner "no podemos acceder a la información" | Falso negativo. Valida contando `<tr>` en `<tbody>`, no buscando la palabra "error". |
| El CSV llega con `Content-Type: text/html` | Es correcto: valida por `Content-Disposition: attachment` o por la cabecera del cuerpo. |
| El CSV tiene exactamente 60.000 filas | Corte silencioso y **alfabético**: la ficha declara 212.173 resultados, pero el CSV se corta por orden, no por fecha. Expedientes `19/T/...` pueden no aparecer. No asumas que puedes particionar el export por filtros: usa la tabla HTML o el CKAN. |
| `cut -d';'` no cuadra | Hay comillas con `;` y saltos de línea. Usa `csv`. |
| Enlaces con `http://` y rutas relativas mezcladas | Normaliza esquema y host antes de deduplicar. |
| El visor de contratos no devuelve nada al hacer `curl` | Es una app JS sin endpoint documentado. Ve al CSV/datastore. |
| Comparar `Content-Length`/hash entre dos GET | El HTML varía ~34 B entre peticiones idénticas. Normaliza antes de comparar. El CSV viaja **chunked, sin `Content-Length`**: no puedes validar tamaño por cabeceras. |

## Salud (SCS) y educación: por dónde entrar

| Necesidad | Ruta |
|---|---|
| Presupuestos | `/transparencia/temas/economica-financiera/presupuestaria-contable/presupuestos/` → tomos PDF por ejercicio (0 tablas). Para cifras usables ve al CKAN: `presupuestos-de-la-comunidad-autonoma-de-canarias-<año>` con `Seccion=39` = SCS. Alternativa estructurada: `https://www3.gobiernodecanarias.org/aplicaciones/unifica/` |
| Contratos | `/transparencia/temas/contratos-convenios-subvenciones/contratacion-y-concesion-servicios/actividad-contractual/formalizados/` → CSV de 60.000 filas (de 212.173 declaradas, ~28%) + `enlace_licitacion`. Para el histórico completo (91.550) ve al CKAN. El "visor de contratos" de la home es **solo JS**: su HTML no trae datos y no expone endpoint. |
| Retribuciones | `/transparencia/temas/institucional-organizativa/retribuciones/retribuciones-personal/personal-funcionario/` → **una sola ficha** con todos los colectivos (funcionarios, laborales, docentes, justicia, policía). El PDF de 2026 es el documento vigente; los XLSX/ODS reutilizables de docentes son de 2023. Subpáginas reales del hub: `altos-cargos`, `personal-confianza`, `gastos-representacion`, `directivos-fondos-europeos`, `retribuciones-organismoautonomos`. `personal-laboral` y `personal-estatutario` **no existen** (404). |
| Listas de espera | `/transparencia/temas/servicios-procedimientos/servicios-procedimientos/listas-espera/` → **enlace muerto**. Ve a los cubos ISTAC (skill `canarias-datos-abiertos`) o SAIP. |
| Plantilla / RPT | `/transparencia/temas/institucional-organizativa/empleados-publicos/rpt/` → PDF/CSV/XLSX por consejería. Es **RPT (puestos)**, no dotación de efectivos. El fichero del SCS suele ir con retraso respecto al resto de consejerías: comprueba la fecha. |
| Educación (landing) | `/transparencia/destacados/por-temas/educacion/` |
| Retribuciones docentes | misma ficha `personal-funcionario`: `doc/retribuciones-2026-personal-docente.pdf` y `doc/formatoreutilizable/*.xlsx` (2023) |

El patrón no cambia entre sanidad y educación: mismas áreas, distinta ficha. Lo que cambia es qué documento cuelga de cada una.

## SAIP (solicitudes de acceso)

El portal no tiene formulario propio: enlaza a la sede electrónica (`sede.gobiernodecanarias.org`), que exige certificado/Cl@ve y firma. **No es automatizable**: prepara el borrador y entrega el envío al humano. IDs de trámite: SCS `7125`, Consejería de Sanidad `10543`, Consejería de Educación `10189`, solicitud genérica `4177`.

## Antes de dar un dato por bueno

1. Comprueba `status`, no el tamaño (los 404 devuelven 9–13 KB de HTML).
2. Cuenta filas y compara con el total que declara la página.
3. Distingue "página actualizada" de "dato actualizado": mira el ejercicio/fecha dentro del documento.
4. Guarda la URL exacta, la fecha de descarga y el número de filas junto a cada cifra.
