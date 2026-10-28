# AGENTS.md — contratación pública y transparencia (España / UE / Canarias)

**Carga la skill correcta ANTES de explorar.** Este repo contiene el conocimiento verificado de dónde están los datos y cómo se mienten: usa las skills, no improvises. España: cualquier órgano de contratación (estatal, autonómico, local) y portales de transparencia u open data; UE: anuncios TED/DOUE.

## Contrato de evidencia (no negociable)

Todo dato publicado necesita lo siguiente; si falta algo, es una pista, no un resultado:

1. La **URL/comando exacto** que lo produjo.
2. La **fuente lógica**: dataset + resource id (CKAN), expediente + ficha (PLACSP), notice (TED), ficha de publicidad activa (portal de transparencia).
3. El **criterio de selección**: qué filas/contratos entran. Un literal de nombre nunca es un criterio (`%Servicio Canario%` ≠ SCS).
4. La **fecha del dato** (período real, ≠ `metadata_modified` ≠ fecha de consulta).
5. **Filas traídas vs total declarado** por la fuente, y si se deduplicó.
6. **Bandera de parcialidad** si aplica (CSV truncado, dataset que empieza en 2020...).
7. **Licencia/atribución** si se republica: "Fuente: Gobierno de Canarias" y equivalentes.

## Enrutado por tarea (3 capas)

| Pregunta | Skill primero | Después |
|---|---|---|
| ¿Cuánto ha adjudicado/presupuestado/contratado un órgano canario (SCS, consejerías)? — cifras agregadas | `canarias-datos-publicos-playbook` (router) | `canarias-datos-abiertos` y/o `canarias-transparencia-portal` |
| ¿Quién ganó tal expediente/pliego concreto, de cualquier órgano de España? | `placsp` | BOE/TED/agregadores → siempre verificar en primaria |
| ¿Anuncio en DOUE/TED, modificación, importe eForms de un comprador UE? | `doue-ted` | ficha PLACSP para el puente expediente↔TED |
| ¿Datos abiertos en un portal CKAN de otra comunidad/país? | `ckan` (genérica) | la skill autonómica si existe |
| ¿Cifras agregadas de gasto/contratos de un órgano NO canario? | `placsp` (fichas/expedientes) + `ckan` (si hay portal de open data) | la skill autonómica si existe |
| ¿Documentos de transparencia de GobCan (retribuciones, RPT, contratos en PDF)? | `canarias-transparencia-portal` | `canarias-datos-abiertos` para las cifras |
| ¿En salud (SCS) o educación de Canarias? | `canarias-datos-publicos-playbook` | según el dato: portal, CKAN o ISTAC |

## Controles y revisión adversarial (obligatorios: antes de dar cualquier cifra)

1. **Contar**: filas traídas vs el total que declara la fuente; discrepancia explicada.
2. **Segunda fuente**: la cifra crítica se contrasta desde una vía lógicamente distinta (CKAN ↔ CSV del portal ↔ PLACSP ↔ BOE ↔ TED ↔ informes de control). Si se espera que discrepe (CSV truncado a 60.000), se dice con su motivo.
3. **Contenedor**: content-type, encoding (Latin-1), delimitador (`;`), páginas de error con código 200, vistas JS sin datos.
4. **Criterio del total**: una suma, un criterio; nunca mezclar adjudicado con estimado, con IGIC, con anualidad ni con factura.
5. **Intenta falsificar tu cifra**: GROUP BY alternativo, filtro inverso, rango mayor; busca el caso que tu criterio excluye injustamente.
6. **Cobertura declarada**: qué se buscó (años, órganos, fuentes), qué no, y cuántas peticiones usaste del presupuesto.
7. **Etiquetas honestas**: [VERIFICADO] / [HIPÓTESIS] / [PENDIENTE] / [NO CONCLUYENTE]. "No encontrado" honesto gana a la cifra inventada. Y pregunta si tu skill está desactualizada: los portales se pudren.

## Método de trabajo

- Presupuesto de peticiones **antes** de empezar (p. ej. 20) y contador constante; `sleep 1-2` entre peticiones.
- Respeta `robots.txt` y los topes documentados (CKAN: 1.000/32.000; Crawl-Delay 10; los PDFs de transparencia están vetados por la policy del portal — decisión humana).
- Cachea localmente lo ya descargado y reutilízalo antes de pedirlo de nuevo.
- Subagentes por dominio para tareas exploratorias con presupuesto propio y salida acotada (tabla + total con criterio + cobertura + errores encontrados).

## Uso responsable

Estos portales son un servicio público para toda la ciudadanía: un uso abusivo los degrada para todos. Presupuesto declarado, petición espaciada, preferir API/CSV oficiales a scraping, sin crawlers masivos. El agente de este repo es *ciudadano*, no crawler.

## Nunca

- Concluir "no hay datos" de un 404 (CKAN bajo rutas), un error con 200, una vista JS o un buscador caído: las alternativas están documentadas en las skills.
- Sumar importes adjudicados y llamarlo "pagado" (son compromisos; la facturación no se publica).
- Citar un agregador sin verificar en fuente primaria (PLACSP/BOE/TED/portal oficial).
- Enviar solicitudes automáticas de SAIP o formularios: requieren certificado y decisión de una persona; traspásalas al humano.
- Publicar datos reales de empresas (NIF, importes, adjudicatarios): los ejemplos de este repo usan datos GENERADOS marcados; guarda los reales para tus documentos de trabajo.
- Mezclar siglas falsamente amigas (el acrónimo del proveedor ≠ empresas del grupo; el producto ≠ el fabricante): usa el NIF.
