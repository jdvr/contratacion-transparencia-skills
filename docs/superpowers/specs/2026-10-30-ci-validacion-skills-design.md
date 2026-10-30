# Diseño: CI de validación de skills (spec + reglas del repo)

Fecha: 2026-10-30 · Estado: aprobado (implementado en la rama `ci-validate-skills`) · Alcance: pequeño cambio

## 1. Intención y por qué

Hoy las reglas de `skills/README.md` (estilo, checklist, marca "Verificado", índice y
enrutado) y los greps de filtración de la receta 5 de `mantenimiento` solo se aplican a
mano, y solo si alguien se acuerda. Con una PR o un push a `main` nada impide publicar un
`SKILL.md` sin frontmatter válido, sin fecha de verificación, con una ruta personal o con
una skill huérfana (existe el directorio pero no está en el índice ni en el enrutado).

**Objetivo:** que el hueco se cierre solo en dos eventos —`pull_request` y `push` a `main`—
con dos capas de comprobación que no se solapen:

1. **Especificación Agent Skills** → la acción de marketplace `Flash-Brew-Digital/validate-skill@v1`.
2. **Reglas propias del repo** → `scripts/check-skills.sh` (bash, sin dependencias).

El script se puede ejecutar en local (`./scripts/check-skills.sh`), así que la receta 5 de
`mantenimiento` deja de ser una lista manual: se convierte en "ejecuta el script y que salga 0".

## 2. Objetivos / no-objetivos / anti-objetivos

**Objetivos**

- Workflow `.github/workflows/validate-skills.yml` que corre en `push` a `main` y en toda PR,
  sobre las 7 skills (no solo las cambiadas: barato, y así se detecta la deriva índice/enrutado).
- La acción valida: frontmatter presente y YAML válido, `name` 1–64 coincidente con el
  directorio, `description` 1–1024, campos opcionales (`license`, `compatibility`,
  `metadata`, `allowed-tools`), y `validate-references: true`.
- El script valida solo lo que la acción no sabe: estilo y coherencia del repo.
- Anotaciones `::error file=…,line=…::` para que el fallo se vea en el diff de la PR.
- CI verde desde el primer run: se normalizan las 3 skills desviadas (decisión abajo).

**No-objetivos**

- No validar contenido semántico: si una cifra del ejemplo cuadra con el portal, o si la
  trampa sigue ocurriendo. Eso es la revisión adversarial humana de `mantenimiento`.
- No detectar datos reales de empresas por patrón (NIF, importes): falsos positivos altos.
  Sigue siendo regla humana del checklist.
- No re-verificar URLs ni hacer peticiones de red en CI (los portales se caen y el CI
  se volvería ruido; además, uso responsable).
- No publicar en el marketplace ni crear una composite action propia.

**Anti-objetivos (fallo aunque el CI esté verde)**

- Un CI que falla por la propia receta de `mantenimiento` (el grep que se autodetecta).
- Un rojo crónico que se ignora: si una comprobación no es accionable, se degrada a
  `::warning` o se quita; no se deja en rojo "por si acaso".

## 3. Restricciones

- La acción es de terceros y no está certificada por GitHub: se fija `@v1` (tag, no `main`)
  y el script propio cubre lo que de verdad importa, así que una retirada de la acción no
  deja el repo sin red.
- `permissions: contents: read` en el workflow; sin secretos.
- El script debe funcionar en macOS (bash 3.2 del sistema) y en `ubuntu-latest`.
- El repo no tiene `package.json` ni toolchain: nada de Node/Python en la capa propia.

## 4. Enfoques considerados

| Enfoque | Qué gana | Qué pierde |
|---|---|---|
| **A. Acción (spec) + `scripts/check-skills.sh` (repo)** — elegido | Cada capa hace lo suyo; la spec la mantiene un tercero; el script corre en local; cero dependencias | Dos sitios donde mirar cuando algo falla |
| B. Un único script Node/Python que lo haga todo | Un solo mensaje de error, sin terceros | Parsear YAML a mano, asumir la deriva de la spec, añadir toolchain a un repo de documentación |
| C. Solo la acción de marketplace | Coste casi cero | No comprueba nada de lo que este repo considera no negociable (fecha, filas, índice, enrutado, fugas) |

## 5. Comprobaciones del script (lista cerrada)

Por cada `skills/*/SKILL.md`:

1. Existe el fichero y el bloque de frontmatter (`---` en línea 1 y cierre). *La validez YAML
   la decide la acción; aquí solo se comprueba presencia para dar un mensaje claro.*
2. `description` empieza por `Use when` (es la superficie de enrutado; regla 1 de estilo).
3. `**Idea central` o primer párrafo en negrita presente (regla 2).
4. Sección `## Mapa real` presente (regla 3).
5. Sección de trampas: `## Trampas` **o** `## Señales de que te estás equivocando` (regla 4).
6. Sección de controles: `## Controles y revisión adversarial` **o**
   `## Antes de dar un dato por bueno` (regla 5).
7. Marca `**Verificado: YYYY-MM-DD` presente, con fecha ISO y no futura (regla 5).
8. Cuerpo ≤ 160 líneas (regla 5) → *hoy `canarias-datos-abiertos` tiene 161*.
9. Sin fugas: `/Users/`, `_API_KEY=`, `@gmail.com`, `BEGIN .*PRIVATE KEY`, tokens tipo
   `ghp_`/`sk-`. **Excepción:** las líneas que contienen `git grep` (la receta que enseña el
   patrón, no un valor).

Coherencia entre ficheros:

10. Todo directorio de `skills/` aparece en la tabla índice de `skills/README.md`.
11. Toda skill enrutada aparece en la tabla de `AGENTS.md`; `mantenimiento` está exenta
    (no se enruta por tarea, se usa para mantener el repo).
12. `.local-mining/` no está trackeado (`git ls-files`).
13. `skills/README.md` y `AGENTS.md` no contienen líneas de fuga (mismas reglas del punto 9).

Salida: `::error file=…,line=…::mensaje` por fallo, resumen final con `N skills, M errores`.
Exit 0 si no hay errores; 1 si hay alguno. Los avisos no rompen el build.

## 6. Decisiones tomadas (mías, revisables)

- **Normalizar las 3 skills desviadas** en el mismo commit, para que el primer run sea verde:
  añadir `**Verificado: <fecha>**` a `canarias-datos-abiertos`,
  `canarias-datos-publicos-playbook` y `canarias-transparencia-portal` (con la fecha real
  de su última verificación documentada, 2026-10; se anota "sin re-ejecutar hoy" cuando
  corresponda), y recortar 1 línea de `canarias-datos-abiertos` (161 → 160).
  La sección `## Antes de dar un dato por bueno` **se acepta como nombre válido** en el
  punto 6: renombrarla a `## Controles y revisión adversarial` cambiaría el texto de 3
  skills sin ganar nada; el script admite ambos nombres.
- **Todas las skills en cada run**, no solo las cambiadas: 7 ficheros tardan menos que la
  detección de cambios, y el drift de índice/enrutado solo se ve mirando el conjunto.
- **Un solo workflow** con dos jobs (`spec`, `repo-rules`) para que el fallo diga de qué capa viene.
- **`workflow_dispatch`** añadido para poder relanzarlo a mano tras cambiar la acción.

## 7. Lo que queda al constructor

- Nombres exactos de los jobs y del step de resumen.
- Mensajes de error concretos (en inglés en CI, como el resto de config del repo, o en
  español como el contenido: se elige español, es contenido del repo).
- README: una línea en "Desarrollo" explicando que el CI corre y cómo lanzarlo en local.

## 8. Cómo quedó implementado (2026-10-30)

La implementación se validó con la acción `@v1` real ejecutada en local (7/7 skills válidas)
y con un clon limpio del repo (`check-skills: 7 skills, 0 errores`). Diferencias respecto a
lo planeado, todas para cerrar huecos que aparecieron al construir:

- **Fugas en todo el árbol versionado**, no solo en las 4+7 rutas del punto 9: se usan
  `git grep` (o `grep -r` si no hay git). Un `_API_KEY=` pegado en `examples/` filtra igual
  que uno en un `SKILL.md`. Única exención: la línea de la receta en
  `skills/mantenimiento/SKILL.md`; `scripts/` y `docs/superpowers/` quedan fuera del escaneo
  porque citan los patrones a propósito.
- **Nombres de sección equivalentes**: `Enrutado por pregunta` y `Gramática de URLs` valen
  como mapa; `Antes de dar un dato por bueno` y `Contrato de evidencia` valen como controles;
  `mantenimiento` está exenta de tabla de trampas (es skill de proceso).
- **Frontmatter**: el cierre solo cuenta en las 6 primeras líneas, para que un `---` del
  cuerpo no se confunda con el fin del frontmatter.
- **Huérfanas**: se exige el nombre entre backticks (como en las tablas), no una subcadena:
  `datos` dentro de `canarias-datos-abiertos` no cuenta como entrada.
- **Directorios sin `SKILL.md`** se marcan como error; antes eran invisibles.
- **La matriz del CI se descubre** del árbol (`discover` + `jq`) y rechaza nombres que no
  sean kebab-case, en vez de la lista fija del plan.
- **El árbol no se toca al validar**: los tests trabajan sobre copias en `mktemp -d`.
