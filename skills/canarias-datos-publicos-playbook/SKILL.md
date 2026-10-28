---
name: canarias-datos-publicos-playbook
description: "Use when necesitas un dato público del Gobierno de Canarias (salud/SCS, educación, presupuestos, contratos, retribuciones, listas de espera, centros) y no sabes en cuál de los portales está, o cuando hay que verificar y citar la cifra con evidencia. Enruta entre el Portal de Transparencia y datos.canarias.es y evita dar por bueno un dato parcial."
---

# Playbook: datos públicos de Canarias (salud y educación)

**Idea central:** hay dos portales con lógicas distintas. Elegir mal cuesta 20 peticiones y una conclusión falsa ("no hay datos").

| Portal | Qué contiene | Cuándo usarlo |
|---|---|---|
| `gobiernodecanarias.org/transparencia` | Documentos oficiales y fichas de publicidad activa (PDF, XLSX, ODS, CSVs puntuales) | Necesitas el **documento** (presupuesto aprobado, memoria, retribuciones, convenio) o una tabla que solo existe ahí |
| `datos.canarias.es` (CKAN + ISTAC) | Datos tabulares y estadísticos, API JSON | Necesitas **cifras filtrables/agregables** (presupuesto por sección, contratos, centros, series) |

Regla práctica: **busca la cifra en CKAN; busca el documento en Transparencia.** Si la cifra no está en CKAN, cae al CSV/HTML del portal; si el documento no está en Transparencia, tú revisa PLACSP antes de darlo por inexistente.

## Enrutado por pregunta

| Pregunta | Fuente primaria | Fuente de contraste |
|---|---|---|
| ¿Cuánto presupuesta el SCS? | CKAN `presupuestos-de-la-comunidad-autonoma-de-canarias-<año>`, `Seccion=39` | Tomo PDF del portal / UNIFICA |
| ¿Cuánto presupuesta Educación? | mismo dataset, `Seccion=18` | Tomo PDF del portal |
| ¿Cuántos contratos tiene el SCS? | CKAN `contratos-...`: **define el criterio**. Literal del nombre → 1.717; conjunto SCS ampliado (gerencias, direcciones de área, DGs) → ~10.436. `%Servicio Canario%` (2.666) **no** sirve: mete 949 de Empleo | CSV del portal (60.000 de 212.173, parcial) |
| ¿Quién ganó un contrato concreto? | CSV/HTML del portal → `enlace_licitacion` | contrataciondelestado.es |
| ¿Cuánto se ha pagado a un proveedor concreto? | CKAN contratos filtrando por **`adjudicataria_nif`** (el dataset no trae nombre) | PLACSP para razón social; API TED v3 para modificaciones (`POST api.ted.europa.eu/v3/notices/search`) |
| ¿Listas de espera? | ISTAC: pacientes en quirúrgica `C00045A_000001/1.4` y consultas `C00045A_000002/1.4`; tasas `C00045A_000004/1.2` | — (el portal está roto) |
| ¿Retribuciones del personal? | Transparencia: ficha de retribuciones (PDF + XLSX) | — |
| ¿Plantilla del SCS? | **RPT sí**: portal (`.../empleados-publicos/rpt/`) y CKAN (`relaciones-de-puestos-de-trabajo-...`) | dotación de efectivos: no publicada → SAIP |
| ¿Centros educativos? | CKAN `centros-educativos-de-canarias` (1.469) | — |
| ¿Centros sanitarios? | solo snapshot COVID 2023 | SAIP |
| ¿Estadística de salud? | CKAN `groups:salud` + ISTAC | — |
| ¿Expediente, pliego o adjudicación concreta (cualquier órgano de España)? | skill `placsp`: ficha deeplink y documentos de la ficha | BOE, TED, agregadores — siempre verificar en primaria |
| ¿Anuncio europeo (TED/DOUE) o modificación por `PayableAmount`? | skill `doue-ted`: API v3 + XML del notice | ficha PLACSP (el número TED sale en la ficha) |
| ¿Datos abiertos en un portal CKAN de otra comunidad? | skill `ckan` (genérica): localiza la ruta de la API con `status_show` | — |

## Salud → educación: qué se transfiere y qué no

**Se transfiere:** el patrón de URL del portal (`/transparencia/temas/...`), el `descargaCSV.jsp` con `contentId`, la semántica `mm=100%` de CKAN, los topes (1.000 / 32.000), el encoding Latin-1 de presupuestos, y la lógica "documento vs cifra".

**No se transfiere:** los códigos. `39` es SCS; `18` es Educación. Las organizaciones CKAN son distintas (`consejeria-de-sanidad` vs `consejeria-de-educacion`, ambas diminutas). Y las listas de espera no tienen equivalente educativo: allí el equivalente operativo es el directorio de centros.

Antes de reutilizar una receta, revalida el código contra `Descripcion Seccion` o `organization.title`. No asumas que el código de sección es estable entre años.

## Contrato de evidencia (no negociable)

Toda cifra que entregues lleva:

1. **URL exacta** (o comando) que la produjo.
2. **Fuente lógica**: dataset `name` + `resource_id`, o ruta de la ficha.
3. **Criterio de selección**: qué filas entraron (p. ej. "entidades del SCS", no solo el literal del nombre).
4. **Fecha** de consulta y **periodo del dato** (no `metadata_modified`).
5. **Filas traídas vs `count` declarado**, y si deduplicaste.
6. **Bandera de parcialidad** si aplica (p. ej. CSV cortado en 60.000).
7. **Licencia/atribución** si el dato se publica.

Si falta cualquiera de 1–5, el dato es una pista, no un resultado.

## Señales de que te estás equivocando

- Concluyes "no hay datos del SCS" tras mirar solo `organization:consejeria-de-sanidad` (3 datasets). Los datos están en Hacienda e ISTAC.
- Usas `/buscador/search` del portal y esperas 60 s. Está roto.
- Tu búsqueda de 3 palabras devuelve miles de resultados. Falta `mm=100%`.
- Traes 1.000 filas y crees que es el catálogo entero.
- Citas una cifra sin decir de qué ejercicio es.
- Descargas 25 PDFs "por si acaso" (mira `Disallow: /*.pdf$` y el aviso legal).
- Un CSV de 25 MB tiene exactamente 60.000 filas y lo tratas como completo.
- Filtras contratos por `%Servicio Canario%` y lo llamas "contratos del SCS" (incluye Empleo).
- Buscas el proveedor por su nombre en el objeto del contrato y concluyes "no hay nada": el objeto nombra el producto (la suite contratada), no al fabricante. Ve por NIF.
- Sumas importes adjudicados y los llamas "pagado": son compromisos, no facturación.
- Das por hecho que el fabricante del producto es el adjudicatario: el mismo producto contratado lo han mantenido varios proveedores distintos. El objeto dice el producto, no quién cobra.
- Mandas a SAIP la plantilla sin haber mirado la RPT, que es pública.

## Flujo mínimo (10 peticiones)

1. `package_search` con `mm=100%` y `fl=` para localizar el dataset (1–2 req).
2. `package_show` para ver recursos y `datastore_active` (1 req).
3. `datastore_search` con `count`/`rows=0` y luego la página necesaria (2–3 req).
4. Si no hay datastore: `mapa-web` del portal + ficha + `descargaCSV.jsp` (2–3 req).
5. Contraste con el documento oficial si la cifra es publicable (1 req).
6. Cachea el resultado en local con su ficha de evidencia.
