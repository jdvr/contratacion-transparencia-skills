---
name: mantenimiento
description: "Use when hay que añadir, actualizar, verificar, sincronizar o retirar una skill de este repo, revisar que nada personal se publica, actualizar el enrutado (AGENTS.md y playbook), o preparar la publicación del repo. Imprescindible cuando alguien pide 'añade una skill', 'está desactualizada', o al final de cada ciclo de análisis para devolver aprendizajes al repo."
---

# Mantenimiento del repo `contratacion-transparencia-skills`

**El repo es la fuente canónica; todo cambio se hace aquí y se sincroniza después.**
Cada cambio pasa por el mismo embudo: verificación en vivo → estilo del repo (5 reglas
de `skills/README.md`) → controles/revisión adversarial → test con agente fresco →
sync de copias globales → commit con convención. Las reglas de naming y el checklist
obligatorio viven en `skills/README.md`; esta skill no los vuelve a formular, te lleva por la rutina.

## Mapa real (qué tocas y dónde vive cada cosa)

| Fichero | Para qué | Se sincroniza con |
|---|---|---|
| `skills/<skill>/SKILL.md` | el activo | `~/.claude/skills/` y `~/.config/opencode/skills/` (si existen) |
| `AGENTS.md` | enrutado 3 capas + contrato de evidencia | nada (raíz del repo) |
| `skills/canarias-datos-publicos-playbook/SKILL.md` | tabla de enrutado por pregunta | `~/.claude/skills/canarias-datos-publicos-playbook/SKILL.md` |
| `skills/README.md` | índice, checklist, naming | nada (raíz de skills/) |
| `examples/` | transcriptos verificados (solo datos públicos) | nada |
| `.local-mining/` | material de construcción (gitignored, NO publicar) | nada |
| `opencode.jsonc` | descubrimiento de skills + agente `mantenedor` | nada |
| `docs/superpowers/` | diseño y plan del proyecto | nada |

## Recetas

1. **Añadir skill nueva** (naming: `[comunidad]-[plataforma]`; genérica: solo plataforma):
   a) re-verifica las URLs clave HOY (`curl`/`webfetch`, ~5-10 peticiones, anótalas);
   b) escribe el SKILL.md según las 5 reglas; c) test adversarial GREEN (agente fresco
   sin y con skill, misma tarea; corrige lo detectado); d) `skills/README.md` índice;
   e) tablas de enrutado (AGENTS.md + playbook si es canaria); f) `examples/` si el caso
   lo merece; g) sync global; h) commit `feat: skill <nombre> (...)`.
2. **Actualizar skill existente** (algo rompió o hay dato nuevo): re-verifica la pieza
   rota, corrige, actualiza la marca "Verificado: <fecha>" y añade la trampa nueva a la
   tabla si el caso documentó una; commit `fix: skill <nombre> (<qué cambió>)`.
3. **Devolver aprendizaje de sesión al repo** (patrón ciclo): lo aprendido en un análisis
   que vale para todos se convierte en: filas de Trampas con caso real, receta nueva,
   o trampa corregida + nueva fecha de verificación. Si fue solo canaria, capa autonómica;
   si valió para el patrón, skill genérica. Un commit por skill.
4. **Sync de copias globales**: `cp skills/<ruta>/SKILL.md ~/.claude/skills/<ruta>/SKILL.md`
   para cada skill tocada; `diff -q` para probar igualdad; si la carpeta global no
   existe, créala. Nunca al revés (la copia global nunca es fuente).
5. **Pre-publicación** (cada vez que vaya a publicarse): `bash scripts/check-skills.sh`
   → exit 0. Cubre frontmatter, marca `Verificado:`, índice y enrutado, y los greps de
   filtración (`git grep` de `/Users/`, `_API_KEY=`, `@gmail.com`, claves; la propia
   línea que enseña el patrón queda exenta). Además `.local-mining` ignorado
   (`git check-ignore .local-mining` exit 0), `git log --oneline` legible y `git status`
   limpio. El mismo script corre en CI en cada PR y push a `main`.
6. **Retirar o jubilar una skill desactualizada grave**: si un portal cambió de raíz y la gramática
   se rompe sin remedio inmediato: marca la skill "Verificado: <fecha> — roto, ver
   <issue/commit>" y quítala del enrutado; no la borres si alguien la usa globalmente,
   documenta el paso de sync en el commit.

## Controles y revisión adversarial del mantenedor

1. **Dif ponderado**: toda skill tocada se contrasta contra su copia global (`diff -q`); si diverge,
   el repo gana.
2. **Filtración**: los greps de la receta 5 son obligatorios antes de push; un dato
   confidencial no se "edita luego".
3. **Verificabilidad**: cada comando nuevo en una skill tiene que poder re-verificarse en
   <10 peticiones; si no cabe, márcalo "(histórico)" y no lo presentes como verificado hoy.
4. **Enrutado coherente**: tras cualquier cambio de skills, relee `AGENTS.md` y la tabla
   del playbook: cada frase-tarea debe seguir llevando a exactamente una única skill primaria.
5. **Adversarial del repo**: pregúntale al repositorio "¿qué está mal aquí?": marca de
   verificación caducada (>6 meses), trampa que ya no ocurre, link muerto, ejemplo con
   cifra que ya no concuerda con el portal. Corrige con fecha.

## Commit convención

`feat:` skill nueva o funcionalidad · `fix:` corrección de skill/contenido ·
`docs:` índices/README/ejemplos · `chore:` scaffolding, git, config.
Un commit = una pieza revisable. Mensaje en español, imperativo.

**Verificado: 2026-10-30** (la receta 5 ya no es un grep manual: la ejecuta
`scripts/check-skills.sh` en local y en CI, con 17 casos de test; el repo se construyó con
esta rutina y el test de aceptación del 2026-10-28 sigue siendo el ejemplo en vivo).

Antes de cerrar un ciclo de mantenimiento: greps de filtración pasados, sync verificado,
índice y enrutado consistentes, `git status` limpio, fechas "Verificado" honestas.
