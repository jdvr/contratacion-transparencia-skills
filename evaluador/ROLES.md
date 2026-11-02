# Roles adversariales del evaluador

Un **rol** es un revisor independiente: contexto fresco, una sola checklist fija y un único claim delante. Cada claim se revisa una vez por rol, y los roles no se ven entre sí ni ven el borrador del autor. Los prompts viven versionados en `src/rubric.ts` (`RUBRIC_VERSION = "rubricV1"`); cambiarlos es un PR que sube la versión, y la versión forma parte de la clave de caché de veredictos.

## Los cuatro roles

| Rol | Id para `--roles` | Qué revisa (checklist real de `src/rubric.ts`) | Veredicto que produce |
|---|---|---|---|
| contadores | `contadores` (alias `contador`) | Filas traídas (`filas_traidas`) vs total declarado (`conteo_declarado`): una diferencia solo vale si el propio claim la explica (dedup documentado, truncado declarado, bandera de parcialidad). **Criterio del total**: el campo `criterio` debe decir en una condición qué filas suman (período, órgano, tipo de fila); un literal de nombre no es criterio. **Mezclas**: «una suma, un criterio» — adjudicado vs estimado/presupuesto, con IGIC vs sin IGIC, una anualidad vs varias, facturación vs adjudicación. | `ok`, `problema` (mezclar bases siempre `bloqueante`) o `sin-re-verificar` si falta el material. |
| segunda-fuente | `segunda-fuente` (alias `segunda`) | Contraste por una **vía lógicamente distinta**: API CKAN vs CSV crudo del mismo dataset, ficha PLACSP vs anuncio BOE/TED, documento del portal de transparencia vs dataset de datos abiertos. Re-consultar el mismo endpoint con otro filtro **no** es segunda fuente. Exige nombrar en `evidencia` cada fuente con su URL y el dato exacto que dio. | `problema` si presenta como segunda fuente una re-consulta del mismo endpoint; `sin-re-verificar`/`aviso` si la fuente queda fuera de la allowlist de fetch. |
| falsificador | `falsificador` | Intenta romper la cifra, no confirmarla: **GROUP BY alternativo** (por año, órgano o grupo de proveedor — el acrónimo del proveedor no es su grupo, se comprueba con el NIF), **filtro inverso** (el complemento exacto del criterio: ¿excluye un caso que una lectura justa incluiría?), **rango mayor** (ampliar período u órganos: ¿la cifra se rompe, esconde un atípico o es un artefacto de la ventana?). Reporta qué ataques corrió y qué dio cada uno. | `ok` si el ataque falla honestamente; `problema` si alguno sobrevive (el claim ocultó algo). |
| metódico | `metodico` | **Cobertura declarada** (qué se buscó y qué no; una cifra sin puntos ciegos es `problema`), **presupuesto de peticiones** (recuento trazable, peticiones espaciadas, API/CSV oficial antes que scraping; la postura es ciudadano, no crawler), **contenedor y encoding** (content-type, Latin-1 vs UTF-8, delimitador, páginas de error con HTTP 200, vistas solo-JS, «no hay datos» desde un 404), y **etiquetas honestas** (`VERIFICADO` solo con `filas_traidas` + `conteo_declarado` + segunda fuente). | `problema` (bloqueante cuando la etiqueta tapa un requisito sin cumplir) o `sin-re-verificar`. |

Los ids son ASCII porque viajan por JSON, CLI y claves de caché; en las salidas humanas el cuarto se presenta como «metódico» (`ROLE_DISPLAY_NAMES`).

## Cómo se ejecutan

- `evaluador eval reporte.md` corre **los cuatro en este orden**: `contadores → segunda-fuente → falsificador → metódico` (`DEFAULT_ROLES`).
- Cada **claim × rol** es una llamada al driver y consume una petición del presupuesto (un reintento de salida estructurada puede costar una segunda). Un claim de cinco cifras con los cuatro roles son veinte llamadas, menos las que sirva la caché.
- **Contexto fresco por rol**: el driver pasa el claim (JSON), el material de apoyo y la allowlist de fetch; ningún rol ve los veredictos de los otros ni el historial de la conversación del autor.
- El rol **solo dictamina**: devuelve un único bloque `json` con `claimId`, `role`, `resultado` (`ok` | `problema` | `sin-re-verificar`), `severidad` (`aviso` | `bloqueante`), `hallazgo` y `evidencia`; todo `problema` y todo `sin-re-verificar` deben traer `hallazgo` en español. La reparación es de quien invoca: leer `.evaluador/issues/`, corregir el reporte y volver a ejecutar. Un rol nunca reescribe la cifra.

## Usar `--roles`

```bash
# un solo rol: humo barato sobre un borrador recién escrito
evaluador eval reporte.md --roles contadores
# alias y varios roles
evaluador eval reporte.md --roles contador,segunda
evaluador eval reporte.md --roles metodico,falsificador
# duplicados: se queda una vez (contadores)
evaluador eval reporte.md --roles contador,contadores
# rol inexistente: exit 3 con "evaluador: unknown role: revisores" (sin estado escrito)
evaluador eval reporte.md --roles revisores
# valor ausente o que empieza por "-" también es exit 3
evaluador eval reporte.md --roles --no-cache
```

Semántica de subset:

- Solo se conduce al driver el subconjunto pedido. Los veredictos previos de los demás roles **se conservan intactos** (no se podan) y `state.roles` acumula la unión: pasar de un subset a otro no pierde revisiones.
- Los pares ya revisados se adoptan desde state/caché (sin gastar petición) salvo `--no-cache`. Los pares **nunca revisados** y los que quedaron en `sin-re-verificar` son los únicos que se re-conducen.
- Los issues se derivan solo para los roles pedidos: un subset no inventa issues de roles que no corrió.
- Cuándo **no** usarlo: para una auditoría o una decisión de cierre, deja los cuatro. Un `exit 0` con subset solo certifica los roles que corriste; la cobertura adversarial completa son los cuatro (o un estado acumulado que ya los tenga).

## Interacciones

- **Presupuesto**: `--budget N` (o `.evaluador/config.json`, por defecto 20) limita las llamadas al driver **de esta ejecución**. Cuidado: si `--budget` es menor que el número de roles por claim, algunos pares no llegan a revisarse; el claim queda con `recheck: "presupuesto-agotado"` (o conserva `sin-re-verificar` si estaba en reintento), se escriben issues «no re-verificado: presupuesto agotado» y el run sale 1. Una ejecución posterior con presupuesto suficiente re-conduce solo lo que falta.
- **Caché**: clave = hash del claim + `RUBRIC_VERSION`, una entrada por rol. Subir la versión de la rubric no reutiliza veredictos viejos; `--no-cache` fuerza re-revisión completa de los roles pedidos. Guardar el veredicto de otro claim es imposible por construcción (el hash incluye el claim).
- **Issues y severidad**: `problema` ⇒ issue en estado `abierta` con la severidad del veredicto (`aviso` = criterio discutible, conviene mirarlo; `bloqueante` = no se confía en la cifra hasta corregir). `sin-re-verificar` ⇒ issue en estado `sin-re-verificar`. Un par que nunca se revisó ⇒ issue `bloqueante`. Todo en `.evaluador/issues/i-NNN.json` con `rubricItem`, `hallazgo` y `propuesta`.
- **Allowlist de fetch**: el rol solo puede pedir URLs citadas en el claim cuyo host esté permitido — `datos.canarias.es`, `gobiernodecanarias.org` y sus subdominios, `contrataciondelestado.es`, `boe.es`, `ted.europa.eu` (tras quitar un `www.` inicial). Un dominio no listado no se fetcha: se declara `sin-re-verificar` y lo decide un humano. En v1 la allowlist es *prompt-enforced*: no hay bloqueo de red a nivel de sistema operativo.
- **Códigos de salida**: `0` sin bloqueantes ni huecos; `1` con hallazgos bloqueantes o huecos declarados (issues escritos); `2` gate estructural; `3` error de uso (rol desconocido, flag mal formada, informe ilegible).

## Mantenimiento

Este documento es el resumen legible de los prompts versionados en `src/rubric.ts`. Si un PR cambia una checklist, `ROLES.md` se actualiza en el mismo PR: no hay test que ate la prosa a los tokens del prompt, así que la comprobación es el ojo humano en la revisión.
