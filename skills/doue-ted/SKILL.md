---
name: doue-ted
description: "Use when se buscan anuncios de contratación en el DOUE (Diario Oficial de la UE, serie S de contratos) o en TED/TDE (Suplemento de Contratación Pública, ted.europa.eu): propuestas arriba de umbrales UE, modificaciones de contrato, importes exactos como `PayableAmount`, o el puente anuncio ↔ expediente PLACSP. Imprescindible cuando la página web de TED falla o bloquea curl, o cuando hay que justificar un importe modificado con el valor del XML oficial."
---

# TED / DOUE — anuncios europeos de contratación (cualquier comprador de la UE)

**La web de TED bloquea curl y muchas páginas de detalle fallan en `webfetch`, pero la API v3 sí responde a curl, y el XML del anuncio es la fuente de importes exactos.** Tres piezas: (1) `POST https://api.ted.europa.eu/v3/notices/search` con JSON `{"query":"publication-number=<N>-<AÑO>","fields":[...],"limit":N}`; (2) el XML en `https://ted.europa.eu/en/notice/<N>-<AÑO>/xml` (también `/pdf` y por idioma); (3) los errores de la API son documentación: pedir un campo inexistente devuelve la lista de valores soportados — úsala para descubrir nombres.

El **DOUE serie S** (contratos por encima de umbrales de la UE) se publica a través de TED: una consulta con `publication-number` en TED es el camino directo al anuncio publicado en el DOUE. Ventana europea genérica, no solo española.

## Mapa real (verificados en vivo el 2026-10-28)

| Tipo | URL / llamada | Qué devuelve |
|---|---|---|
| API de búsqueda | `curl -s -X POST https://api.ted.europa.eu/v3/notices/search -H "Content-Type: application/json" -d '{"query":"publication-number=<N>-<AÑO>","fields":["publication-number","notice-title","buyer-name"],"limit":3}'` | JSON con `notices[]`, campos pedidos (values también por idioma: `buyer-name.spa`) y `links.xml`/`links.pdf` |
| XML del notice | `curl -sL https://ted.europa.eu/en/notice/<N>-<AÑO>/xml` | XML eForms; importes en `cbc:PayableAmount currencyID="EUR"` |
| Descubrimiento de campos | mismo POST con un campo inventado | error `"Parameter 'fields' contains unsupported value (supported values are: ...)"` |
| PDF | `https://ted.europa.eu/es/notice/<N>-<AÑO>/pdf` | binario; mejor el XML para datos |

Ejemplo (esqueleto, datos generados): notice `<N>-<AÑO>` = modificación del contrato de licencias del proveedor ficticio de la sanidad autonómica (expediente PLACSP `SS/T/21/ZZ/CO/N/0097`): `cbc:PayableAmount` = **importe acumulado tras la modificación** (original + modificación). El puente PLACSP → TED es directamente visible: las fichas PLACSP o sus anuncios citan el número de publicación TED.

## Recetas

1. **Buscar un anuncio por número**: POST de arriba. Si tienes el número desde la ficha PLACSP (columna DOUE / idEvl de detalle → número TED en el anuncio), es `publication-number=<N>-<AÑO>`.
2. **Importes exactos**: baja el XML y extrae los amounts: `grep -o 'cbc:[a-zA-Z]*Amount[^>]*>[0-9.]*' notice.xml` — busca `PayableAmount` (importe total), `TotalAmount`, `EstimatedValue`. Cruza siempre con la ficha PLACSP u otra fuente: **una cifra = dos fuentes**.
3. **Descubrir campos válidos**: dispara el error con `fields:["campo-inventado"]` y recorta la lista; los nombres útiles empiezan por `BT-` (eForms) según el dato (buyer → `organisation-*`, valores → `*value*`, resultados → `*result*`).
4. **Puente con PLACSP**: expediente español ↔ número TED. Desde la ficha PLACSP (skill `placsp`) sacas el número TED del anuncio; desde el TED, el buyer-name y el título llevan al expediente. Útil para rastrear la vida completa de un contrato: licitación (anuncio) → adjudicación → modificación.

## Trampas

| Síntoma | Realidad |
|---|---|
| curl a la web de TED (páginas HTML) → bloqueo/000 | Solo el API endpoint responde seguro; páginas de detalle con `webfetch` fallan a menudo |
| Campo `fields` rechazado | No es un fallo: el error te da la lista de campos válidos — descubre así |
| Importe "mal" en el PDF | Los PDFs varían por idioma/route; el XML eForms es la fuente canónica de importes |
| Varias cifras para "el" contrato | Diferencia licitación, adjudicación, modificación y acumulado (`PayableAmount` tras la modificación); etiqueta cada cifra con su anuncio |
| Anuncio sin importes | Los notices de pre-información no los llevan; no infieras |
| Número sin año | El formato canónico es `N-<AÑO>`; sin año no se resuelve |
| Idioma del notice | `links.pdf` viene por idioma (SPA, ENG, ...); el XML por defecto es `MUL` con traducciones — pide `/xml` en `/en/` |

## Controles y revisión adversarial (obligatorios)

1. **Una cifra, dos fuentes**: el importe del XML se contrasta con la ficha PLACSP (o con la suma del original + modificación en el expediente). Discrepancia → se cita ambas con fecha y se explica la diferencia.
2. **Fecha correcta**: fecha de publicación del anuncio ≠ fecha de la modificación ≠ fecha de formalización en PLACSP; di cuál citaste.
3. **Criterio del importe**: ¿adjudicado, modificado, acumulado, valor estimado? El error clásico es sumar una modificación al importe ya acumulado de otro anuncio.
4. **Contenedor**: el XML responde como binario/texto según ruta; valida que puedas parsear antes de creer que "no hay datos".
5. **Adversarial**: intenta falsificar tu importe (busca la modificación anterior y la posterior del mismo contrato con otra query de campos); declara cobertura (qué anuncios del contrato localizaste); etiqueta VERIFICADO / HIPÓTESIS / NO CONCLUYENTE; comprueba si la skill está desactualizada con una llamada hoy (la API cambia poco, pero los campos eForms sí evolucionan).

**Verificado: 2026-10-28 en vivo** (API v3 `notices/search`, XML de un notice con su `cbc:PayableAmount` (importe específico no publicado: es re-identificable), descubrimiento de campos por error). Pendiente honesto: navegación EUR-Lex del DOUE serie S (histórico pre-TED-único) — no verificado hoy; si lo necesitas, entra por `eur-lex.europa.eu` y actualiza esta skill.

Antes de dar un dato por bueno: número TED + URL/API exacta, XML o JSON que lo produce, criterio del importe, contraste con la ficha PLACSP, fecha de consulta.
