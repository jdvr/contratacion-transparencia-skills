# Design: paralelismo de revisión en `evaluador`

Fecha: 2026-11-02 · Estado: **propuesto, pendiente de aprobación humana**

## Intención y por qué

Un run de 4 claims × 4 roles son 16 llamadas al driver, en serie. Con un modelo
lento (se observó una llamada de 4m04s con `opencode-go/beam-free`) el cierre
tarda decenas de minutos aunque la mayoría de los pares estén listos en segundos.
La latencia es del modelo, no del harness, pero el harness la multiplica al
serializar llamadas independientes.

Paralelizar los pares `claim × rol` reduce el tiempo de pared casi linealmente
hasta el número de workers. Es la mejora de velocidad con mayor impacto y no
cambia el contrato de evidencia: los veredictos, la severidad, el budget y los
artefactos siguen siendo los mismos.

## Objetivos

- Ejecutar hasta `N` pares `claim × rol` concurrentemente (`--jobs N`).
- Default del CLI: **4** (los cuatro roles); `--jobs 1` reproduce exactamente el
  comportamiento secuencial actual.
- Mantener determinismo: state, veredictos e issues se materializan siempre en
  orden `claim → rol`, aunque las respuestas lleguen desordenadas.
- Mantener el budget como cota *blanda*: no se lanza ningún par nuevo cuando
  `spent >= budget`; las tareas ya en vuelo terminan. El sobrepaso queda
  declarado (ver abajo), nunca silencioso.
- Mantener la reanudación: un run interrumpido o pausado por budget reanuda solo
  los pares que faltan, con o sin paralelismo.
- Progreso visible: una línea por par y heartbeat por llamada en vuelo.

## No-objetivos

- No es un scheduler distribuido ni multi-proceso.
- No añade reintentos/backoff ni rate-limit-aware scheduling (v1: si el provider
  limita, el par queda `sin-re-verificar` y se puede bajar `--jobs`).
- No cambia el driver, la rubric, el gate, la allowlist ni el contrato de salida.
- No añade `jobs` a `.evaluador/config.json`; es un flag por ejecución.
- No introduce un modelo por rol (sigue habiendo un `--model` por run).

## Anti-objetivos

- Un paralelismo que rompa el determinismo de ids/ramas/issues.
- Un paralelismo que permita un número ilimitado de llamadas por budget.
- Un paralelismo que deje procesos `opencode run` huérfanos al interrumpir.
- Un paralelismo que convierta un fallo de una llamada en un fallo del run
  completo: cada par se contiene como hoy.

## Restricciones

- Node es single-threaded: la concurrencia es de I/O (subprocesos `opencode run`),
  no de CPU. No hay locks; la atomicidad se resuelve por orden de ejecución.
- `Budget`, `VerdictCache` y `state` son síncronos; no requieren cambios de API
  para concurrencia.
- El driver ya soporta `AgentCall.signal` y mata su subproceso al abortar; el
  scheduler debe esperar a que todas las tareas en vuelo terminen antes de salir.
- Código en inglés; docs y salidas humanas en español (convención del repo).

## Enfoques considerados

| Enfoque | Qué paraleliza | Veredicto |
|---|---|---|
| **A. Pool de todos los pares (elegido)** | Cualquier `claim × rol` pendiente, con `N` workers | Máxima velocidad; un rol lento no bloquea otros claims. Coste: state/checkpoint e interrupción por par. |
| B. Por claim | Los roles de un claim a la vez; claims en serie | Simple, pero un rol lento bloquea el claim siguiente. |
| C. Por claims | Varios claims a la vez; roles en serie | Simple, pero un claim lento bloquea su worker y el techo es el número de claims. |

El humano eligió **A** con default 4 y sobrepaso de budget tipo `N-1` (tareas ya
en vuelo) para no denegar reintentos.

## Diseño

### Plan de pares y adopción

Antes de lanzar nada se construye un plan en orden `claim → rol`:

- Por claim: `hash` (claim + `RUBRIC_VERSION` + `modelLabel`), `reusable` del
  state, `retryClaim` (`recheck === "sin-re-verificar"`), `pendingSinReverificar`.
- Por par: si el veredicto previo se puede adoptar (`canAdopt && priorForRole`)
  o hay cache hit (`cache.get`), se rellena el acumulador y **no** se encola.
  Un par adoptado no consume budget.
- Los pares que necesitan driver se encolan como `PairTask` con su índice estable
  `[i/total]`.
- El plan no decide el budget: eso se comprueba justo antes de lanzar cada tarea.

### Acumulador por claim

Cada claim tiene un acumulador con `verdictsByRole: Verdict[][]` indexado por el
orden de `roles`, más `budgetGap`, `interrupted` y `pendingSinReverificar`. Las
respuestas concurrentes escriben en su índice; al materializar el state se
aplanan en orden de rol. Esto conserva el orden que hoy ven `writeIssues`,
`report.ts` y las ramas `problema/<claimId>`.

`recheck` se calcula cuando el claim tiene todos sus roles pedidos resueltos
(veredicto o hueco), con la misma prioridad que hoy:
`interrumpido` > `sin-re-verificar` > `presupuesto-agotado`.

### Scheduler

```
workers = min(jobs, tasks.length)
cada worker:
  mientras queden tareas y no haya abort:
    task = siguiente tarea (cursor síncrono)
    si budget.exhausted: marcar hueco de budget y seguir
    si no: runTask(task)  // await invokeDriver con timeout y signal
```

- `jobs` se valida como entero positivo; `runEval` default **1** (compatibilidad
  con llamadas embebidas y con la suite actual); el CLI pasa `jobs ?? 4`.
- `jobs > tasks.length` se recorta a `tasks.length`.
- No hay `await` entre la comprobación de budget y el lanzamiento: en Node no se
  intercala otra tarea.
- Al terminar una tarea: asignar `claimId`, `role`, `cache.put`, `budget.take(calls)`,
  `petitions += calls`, emitir progreso y checkpoint.
- Si el signal de run está abortado, no se lanzan tareas nuevas; las que están en
  vuelo abortan su subproceso y se marcan `interrumpido`.

### Budget con concurrencia

- La comprobación es `budget.exhausted` antes de lanzar; el cobro es
  `budget.take(result.calls)` después.
- Las tareas ya lanzadas terminan: el gasto real puede superar `budget` en hasta
  `jobs-1` llamadas (las que estaban en vuelo al agotarse), **más el posible
  reintento de cada una** (el mismo `+1` que ya acepta el modo secuencial). Sin
  reintentos, el sobrepaso máximo es exactamente `jobs-1`; con reintentos, cada
  llamada en vuelo puede añadir una más. No hay una cota dura más allá de eso.
- `spentThisRun` y `state.petitions` registran el gasto real; el resumen lo
  declara. No se lanza ninguna tarea nueva tras `spent >= budget`.
- Los pares no lanzados quedan sin veredicto y su claim recibe
  `recheck: "presupuesto-agotado"` (o conserva `sin-re-verificar` si estaba en
  reintento). Exit 1 y issues «no re-verificado: presupuesto agotado».

### Checkpoint e interrupción

- Se hace checkpoint tras **cada par** que termina (state + cache atómicos). El
  coste está acotado (16 escrituras pequeñas en el caso típico) y un kill duro
  conserva todo lo completado.
- El state parcial puede contener claims con solo algunos roles; al reanudar, los
  roles ausentes se re-conducen por el camino normal (sin marcador especial).
- SIGINT/SIGTERM: abortar el `runController`; los `invokeDriver` en vuelo
  devuelven `aborted`; los workers dejan de lanzar; `Promise.allSettled` espera a
  todos; se guarda el state y los claims con pares sin resolver reciben
  `interrumpido`. `runEval` no llama a `process.exit`.
- **Fallo de escritura** (state/cache/checkpoint lanza): el scheduler aborta el
  `runController`, deja de lanzar, drena las llamadas en vuelo con
  `Promise.allSettled` y **re-lanza** el error para que el CLI lo mapee a exit 3.
  Nunca se abandona un `opencode run` vivo por un throw de I/O.

### Determinismo

- `state.claims` en orden del gate; `verdicts` en orden de `roles`.
- `writeIssues` recibe el state ya ordenado; los ids `i-001…` y las ramas
  `problema/<claimId>` no dependen del orden de finalización.
- Un run paralelo y uno secuencial con las mismas respuestas producen el mismo
  state/issue JSON (salvo `updatedAt`).

### Progreso

- Cabecera: `... pair(s); roles: ...; model: ...; jobs: N; timeout ...`.
- Una línea por par: `reviewing`, `still running` (heartbeat), `ok|problema|
  sin-re-verificar (severidad)`, `cache hit`, `reused from state`,
  `budget exhausted`, `TIMEOUT`, `interrupted`.
- Las líneas pueden intercalarse; el tag `[i/total]` desambigua.
- El resumen final añade `jobs` y, si hubo sobrepaso,
  `spentThisRun/budget (+X calls over budget)`, donde `X = spentThisRun - budget`
  (llamadas reales, no tareas). Esto es solo la línea de stderr: `resumen.json`
  y `RunStats` no cambian (su conjunto de claves es contrato máquina).

### CLI

- `--jobs N` (entero positivo; default 4). `--jobs 1` = secuencial.
- `--jobs 0`, negativo, no numérico o sin valor ⇒ exit 3.
- `MainDeps.jobs` para tests; el flag gana sobre el default.
- `--help` y README/ROLES documentan el flag y el sobrepaso.

## Tests

- Parseo de `--jobs` (válido, 0, negativo, texto, ausente) ⇒ exit 3 en los inválidos.
- Concurrencia máxima observada: driver fake con barrera; `jobs 3` ⇒ `maxActive === 3`.
- Budget: `budget 2`, `jobs 4`, 4 tareas en barrera ⇒ **5 llamadas** (sobrepaso
  3 = `jobs-1`: al cobrarse la primera, `spent` aún es 1 < 2 y un worker lanza la
  quinta antes de que las otras tres cobren), pares restantes con hueco, exit 1,
  `petitions === 5`. Los tests existentes que fijan conteos exactos del modo
  secuencial (`--budget 5` con 5 llamadas, etc.) pasan a `--jobs 1` o se
  re-afirman con el nuevo límite; no se aceptan conteos viejos con default 4.
- Determinismo: driver que resuelve en orden inverso; state/issue JSON iguales a
  los de `jobs 1` (ignorando `updatedAt`).
- Reanudación: primer run con budget insuficiente; segundo con budget suficiente
  ⇒ solo los pares que faltan llegan al driver y el run cierra.
- Interrupción: dos llamadas colgadas con `jobs 2`; SIGINT ⇒ exit 1, state con
  `interrumpido`, sin llamadas en vuelo al volver.
- Cache hit: segundo run paralelo ⇒ 0 llamadas al driver.
- Los tests existentes siguen con `runEval` default 1; los que llaman a `main`
  sin `--jobs` pasan a default 4 y se revisan si dependen del orden **o del
  conteo exacto de budget** (esos se fijan a `--jobs 1`).
- **Smoke real**: 4 llamadas concurrentes de `opencode run` sobre el fixture antes
  de dar el default 4 por bueno; si el provider limita, se documenta `--jobs 2`
  (no se cambia el default sin evidencia).

## Documentación

- `evaluador/README.md`: `--jobs`, default 4, `--jobs 1`, sobrepaso de budget,
  límites del provider y recomendación `--jobs 2` para modelos free.
- `evaluador/ROLES.md`: bullet en «Cómo se ejecutan» con el paralelismo y el
  sobrepaso; el orden de los roles no cambia.
- `AGENTS.md` no necesita cambios.

## Riesgos y mitigaciones

- **Rate limits del provider**: 4 llamadas concurrentes pueden recibir 429; el
  driver no reintenta, así que el par queda `sin-re-verificar` y exit 1. Mitigación:
  documentar `--jobs 2`; no cambiar el driver en este trabajo.
- **Presión sobre el servidor opencode**: cada `opencode run` es un cliente del
  servidor de fondo; 4 es conservador. `--jobs 1` sigue disponible.
- **Sobrepaso de budget**: declarado en `spentThisRun`/`petitions`; no se lanzan
  tareas nuevas pasado el tope.
- **State parcial**: se reanuda por el camino normal; el invariante pre-exit
  sigue rechazando un exit 0 con pares pedidos sin veredicto.

## Fuera de alcance

- Rate-limit-aware scheduling, retries con backoff, prioridad por claim.
- Modelo por rol, `--jobs` en config, workers distribuidos.
- Cambios en rubric, gate, allowlist, driver o formato de artefactos.
