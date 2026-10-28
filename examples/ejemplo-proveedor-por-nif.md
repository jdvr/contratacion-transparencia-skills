# Ejemplo (datos generados): ¿cuánto ha adjudicado la sanidad autonómica al proveedor "ProSalud Sistemas"?

Ejemplo de trabajo, en la forma *tarea → comandos → resultado → controles → fuentes*.
**Todos los datos de empresa, expedientes e importes de este ejemplo son GENERADOS
(ficticios, marcados así)**; solo la estructura (URLs, APIs, nombres de columna) es real
y se usa tal cual con los portales reales.

## Tarea

"Cuánto ha adjudicado la Consejería de Sanidad de mi comunidad (el servicio de salud) a
**ProSalud Sistemas, S.L.U.** o empresas similares de su grupo, por licencias, por año y
por concepto."

## Punto de partida (verificado en los portales: es la forma, no el dato)

- NIF del ejemplo: **B00000001** (NIF ficticio; en la práctica lo obtienes de una ficha
  PLACSP: los datasets de contratos **no traen nombre de adjudicataria, solo
  `adjudicataria_nif`**).
- El `objeto_contrato` nombra productos (la suite clínica "ClínicaPlus", su módulo de
  atención primaria), no al fabricante.

## Comandos (CKAN; la ruta real de la API la descubres con `status_show`, skill `ckan`)

```bash
B="<ruta_real>/api/3/action"; R="<recurso_del_dataset_de_contratos>"

# por NIF, cronológico
curl -sG "$B/datastore_search_sql" --data-urlencode \
  'sql=SELECT adjudicacion_fecha, expediente_numero, objeto_contrato, importe_ofertado \
   FROM "<R>" \
   WHERE adjudicataria_nif = $$B00000001$$ ORDER BY adjudicacion_fecha'

# ¿existen otras razones sociales del grupo? por objeto + NIF, nunca por sigla
curl -sG "$B/datastore_search_sql" --data-urlencode \
  'sql=SELECT adjudicataria_nif, count(*) n \
   FROM "<R>" \
   WHERE objeto_contrato ILIKE $$%clinicap%$$ OR objeto_contrato ILIKE $$%atencion primaria%$$ \
   GROUP BY adjudicataria_nif ORDER BY n DESC'

# total con criterio explícito
curl -sG "$B/datastore_search_sql" --data-urlencode \
  'sql=SELECT sum(importe_ofertado::numeric) FROM "<R>" \
   WHERE adjudicataria_nif = $$B00000001$$'

# abrir la ficha PLACSP de cada `enlace_licitacion` con webfetch (curl está bloqueado)
```

## Resultado (criterio: NIF del ejemplo, adjudicaciones del dataset)

| Año | Expediente (fict.) | Objeto (fict.) | Importe | Fuente |
|---|---|---|---|---|
| 2021 | `SS/T/21/ZZ/CO/N/0097` (estructura real, datos ficticios) | Renovación licencias ClínicaPlus + soporte nivel 3 | 1.400.000,10 € | ficha PLACSP + CKAN |
| 2024 | `SS/T/24/ZZ/CO/N/0021` | Renovación licencias + suscripciones del portal | 1.800.000,00 € | ficha PLACSP + CKAN |

- Total **3.200.000,10 €** (criterio: suma de adjudicados por NIF en el dataset).
- Con la modificación ficticia del contrato de 2021 (+100.000,00 € publicada como
  modificación en TED, `cbc:PayableAmount` = 1.500.000,10 €): **3.300.000,10 €** — dato
  distinto con criterio distinto (acumulado con modificaciones).
- Los mantenimientos del producto NO son el mismo proveedor: "el mismo producto lo
  mantienen varias empresas" — lección de "producto ≠ proveedor".

## Controles aplicados (sección adversarial de las skills)

1. **Criterio del total** declarado antes de sumar (NIF-based; sin deduplicar).
2. **Segunda fuente**: cada importe se contrastó con su ficha PLACSP y la modificación
   con el XML de TED; el dato "solo NIF" del dataset se resolvió con las fichas.
3. **Cobertura**: siempre pregunta qué ventanas temporal y orgánica quedan fuera (por
   ejemplo datasets disponibles solo desde un año) y que "pagado" no existe en el
   portal (solo compromisos adjudicados) — se dice.
4. **Aliases fragiles**: se buscó por NIF, no por la sigla (pega con terceros); NIF
   válido (letra + 8 dígitos) verificado antes de hacer joins.

## Fuentes (reales)

- CKAN contratos: `https://datos.canarias.es/catalogos/general/dataset/contratos-adjudicados-y-formalizados-del-gobierno-de-canarias` (el dataset real; las cifras y expedientes de arriba son generados)
- Fichas PLACSP vía `webfetch` con `idEvl` de la ficha: ver skill `placsp`
- Modificación en TED: XML `https://ted.europa.eu/en/notice/<N>-<AÑO>/xml`; ver skill `doue-ted`

Fecha de consulta: 2026-10-28. Los datos de empresa/expedientes/importes son GENERADOS.
Etiquetas de guía: total por NIF [MÉTODO verificado en sesión; cifras aquí generadas],
"grupo por alias" [MÉTODO general], pagado/anualidad [NO CONCLUYENTE — el facturado no se publica].
