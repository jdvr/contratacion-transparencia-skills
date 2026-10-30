# CI de validación de skills — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un workflow de GitHub Actions que valide cada `skills/*/SKILL.md` contra la especificación Agent Skills (acción de marketplace) y contra las reglas propias del repo (script bash), en `pull_request` y `push` a `main`.

**Architecture:** Dos jobs independientes. `spec` invoca `Flash-Brew-Digital/validate-skill@v1` una vez por skill vía matriz. `repo-rules` ejecuta `scripts/check-skills.sh`, un script bash sin dependencias que recorre las skills y la coherencia índice/enrutado, emite anotaciones `::error file=,line=` y sale con 1 si hay fallos.

**Tech Stack:** bash 3.2 (compatible macOS), GitHub Actions YAML. Sin Node, sin Python, sin red.

**Spec:** `docs/superpowers/specs/2026-10-30-ci-validacion-skills-design.md`

## Global Constraints

- Sin dependencias nuevas: ni `package.json`, ni `requirements.txt`.
- El script debe correr en bash 3.2 (macOS del sistema): nada de arrays asociativos, `mapfile`, `${var,,}`, `[[ =~ ]]` con capturas extendidas.
- Sin peticiones de red en CI.
- `permissions: contents: read` y ningún secreto.
- Mensajes del script en español (es contenido del repo), como el resto de `skills/`.
- La acción se fija a `@v1`, nunca `@main`.
- Ningún dato real de empresas, ruta personal ni clave puede acabar en el repo; el propio script lo comprueba.

## Review Focus

- Una línea que contiene la receta `git grep -n "/Users/\|_API_KEY=\|@gmail.com"` (en `mantenimiento`) no debe hacer fallar el check de fugas: la exención es "la línea contiene `git grep`", y esa línea debe seguir pasando aunque se reformule.
- Una skill nueva recién añadida sin entrada en `skills/README.md` ni en `AGENTS.md` debe fallar con un mensaje que nombre el directorio huérfano, no con un volcado de errores.
- `mantenimiento` no se enruta en `AGENTS.md` por diseño: exigirla ahí rompería el CI el día uno.
- Una fecha `Verificado:` en el futuro (typo `2027-…`) debe fallar; una fecha vieja no debe fallar (caducidad es revisión humana, no CI).
- El script ejecutado desde cualquier directorio debe encontrar la raíz del repo por sí mismo (se lanza desde la raíz en CI, pero en local se lanzará desde donde sea).

---

### Task 1: `scripts/check-skills.sh` + su test de fixtures

**Files:**
- Create: `scripts/check-skills.sh`
- Create: `scripts/test-check-skills.sh`

**Interfaces:**
- Consumes: nada.
- Produces: `scripts/check-skills.sh [root]` → exit 0/1; stdout con líneas `::error file=<ruta relativa>,line=<n>::<mensaje>` y `::warning …`; última línea `check-skills: N skills, E errores, W avisos`. Si `root` se omite, usa el directorio padre del script.

- [ ] **Step 1: Escribir el test que falla**

`scripts/test-check-skills.sh` crea un root temporal con un fixture mínimo verde y luego lo rompe, una regla por caso:

```bash
#!/usr/bin/env bash
# Test de fixtures para scripts/check-skills.sh
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/check-skills.sh"
FAILS=0

make_root() {  # root con una skill verde, índice y enrutado coherentes
  R="$(mktemp -d)"
  mkdir -p "$R/skills/demo" "$R/scripts"
  printf -- '---\nname: demo\ndescription: "Use when hay que probar el validador."\n---\n\n# Demo\n\n**Idea central:** una.\n\n## Mapa real\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n## Trampas\n\n| Síntoma | Realidad |\n|---|---|\n| a | b |\n\n## Controles y revisión adversarial\n\n1. cuenta.\n\n**Verificado: 2026-10-30**\n' > "$R/skills/demo/SKILL.md"
  printf '# Skills\n\n| Skill | Uso |\n|---|---|\n| `demo` | probar |\n' > "$R/skills/README.md"
  printf '# AGENTS\n\n| Tarea | Skill |\n|---|---|\n| probar | `demo` |\n' > "$R/AGENTS.md"
  echo "$R"
}

expect() {  # expect <código esperado> <texto en salida> <root>
  out="$("$SCRIPT" "$3" 2>&1)"; code=$?
  if [ "$code" -ne "$1" ] || ! printf '%s' "$out" | grep -q -- "$2"; then
    echo "FALLO (esperaba $1 + '$2', salió $code):"; printf '%s\n' "$out"; FAILS=$((FAILS+1))
  else echo "ok: $2"; fi
}

R="$(make_root)";     expect 0 "0 errores" "$R"
printf '\n**Verificado: 2099-01-01**\n' >> "$R/skills/demo/SKILL.md"; expect 1 "futura" "$R"
R="$(make_root)"; sed -i '' 's/^\*\*Verificado.*//' "$R/skills/demo/SKILL.md" 2>/dev/null || sed -i 's/^\*\*Verificado.*//' "$R/skills/demo/SKILL.md"; expect 1 "Verificado" "$R"
R="$(make_root)"; sed -i '' 's/^## Trampas/## Otra cosa/' "$R/skills/demo/SKILL.md" 2>/dev/null || sed -i 's/^## Trampas/## Otra cosa/' "$R/skills/demo/SKILL.md"; expect 1 "trampas" "$R"
R="$(make_root)"; printf '\nmail: alguien@gmail.com\n' >> "$R/skills/demo/SKILL.md"; expect 1 "fuga" "$R"
R="$(make_root)"; printf '\n    `git grep -n "/Users/\\|_API_KEY=\\|@gmail.com"`\n' >> "$R/skills/demo/SKILL.md"; expect 0 "0 errores" "$R"
R="$(make_root)"; mkdir -p "$R/skills/huerfana"; cp "$R/skills/demo/SKILL.md" "$R/skills/huerfana/SKILL.md"; sed -i '' 's/^name: demo/name: huerfana/' "$R/skills/huerfana/SKILL.md" 2>/dev/null || sed -i 's/^name: demo/name: huerfana/' "$R/skills/huerfana/SKILL.md"; expect 1 "huérfana" "$R"
R="$(make_root)"; : > "$R/skills/demo/SKILL.md"; for i in $(seq 1 200); do echo "relleno $i" >> "$R/skills/demo/SKILL.md"; done; expect 1 "líneas" "$R"

echo "----"; [ "$FAILS" -eq 0 ] && echo "TEST GREEN" || { echo "TEST RED ($FAILS)"; exit 1; }
```

- [ ] **Step 2: Ejecutarlo y verificar que falla**

Run: `bash scripts/test-check-skills.sh`
Expected: falla en el primer caso (`check-skills.sh` no existe o no imprime `0 errores`).

- [ ] **Step 3: Implementar `scripts/check-skills.sh`**

Estructura exacta:

```bash
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ERRORS=0; WARNINGS=0
err()  { printf '::error file=%s,line=%s::%s\n' "$1" "$2" "$3"; ERRORS=$((ERRORS+1)); }
warn() { printf '::warning file=%s,line=%s::%s\n' "$1" "$2" "$3"; WARNINGS=$((WARNINGS+1)); }
```

Comprobaciones, en este orden, con `grep -n` para obtener la línea:

1. `frontmatter`: línea 1 `---` y cierre en las 6 primeras líneas → si no, `err` y saltar el resto de esa skill.
2. `description` (`^description:`) → el valor debe empezar por `Use when` (tras comillas opcionales): si no, `err`.
3. `Idea central`: el primer párrafo del cuerpo (primera línea tras el frontmatter) debe empezar por `**`: si no, `err`.
4. `## Mapa real`: `grep -n '^## Mapa real'`: si no, `err`.
5. `trampas`: `^## Trampas` o `^## Señales de que te estás equivocando`: si no, `err` con mensaje que mencione "tabla de trampas".
6. `controles`: `^## Controles y revisión adversarial` o `^## Antes de dar un dato por bueno`: si no, `err`.
7. `Verificado`: `^\*\*Verificado: [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]`: si no, `err` "falta la marca **Verificado: YYYY-MM-DD**"; si la fecha es `> $(date +%Y-%m-%d)`, `err` "fecha de verificación futura".
8. Líneas: `wc -l < f` > 160 → `err` "N líneas (máximo 160)".
9. Fugas en el SKILL.md: por cada patrón `/Users/`, `_API_KEY=`, `@gmail.com`, `BEGIN .*PRIVATE KEY`, `ghp_[A-Za-z0-9]`, `sk-[A-Za-z0-9]` → `grep -nE`; se descartan las líneas que contienen `git grep`; por cada resto, `err` "fuga: patrón X".

Coherencia global (tras recorrer skills):

10. Cada `<dir>` de `skills/*/` debe aparecer en `skills/README.md` → `grep -q -- "$dir"`; si no, `err` en `skills/README.md:1` "skill huérfana: $dir no está en el índice".
11. Cada `<dir>` salvo `mantenimiento` debe aparecer en `AGENTS.md` → si no, `err` "skill huérfana: $dir no figura en el enrutado de AGENTS.md".
12. Fugas en `skills/README.md`, `AGENTS.md` y `README.md` con la misma función y la misma exención.
13. `.local-mining` no trackeado: si `git -C "$ROOT" ls-files --error-unmatch .local-mining >/dev/null 2>&1`, `err` "material local trackeado".

Termina con `printf 'check-skills: %s skills, %s errores, %s avisos\n' "$N" "$ERRORS" "$WARNINGS"` y `[ "$ERRORS" -eq 0 ]`.

Nota: los avisos (`warn`) no existen aún; la función se define para el paso 9 de la spec futura. Si no se usa, `WARNINGS` se mantiene en 0 y la salida es honesta.

- [ ] **Step 4: Ejecutar el test y verificar que pasa**

Run: `bash scripts/test-check-skills.sh`
Expected: todos los `ok:` y `TEST GREEN`.

- [ ] **Step 5: Commit**

```bash
git add scripts/
git commit -m "feat: script de validación de reglas del repo sobre SKILL.md"
```

---

### Task 2: Normalizar las 3 skills desviadas

**Files:**
- Modify: `skills/canarias-datos-abiertos/SKILL.md`, `skills/canarias-datos-publicos-playbook/SKILL.md`, `skills/canarias-transparencia-portal/SKILL.md`

**Interfaces:**
- Consumes: `scripts/check-skills.sh` de la Task 1.
- Produces: el repo real pasa el script con exit 0.

- [ ] **Step 1: Añadir la marca a las 3 skills**

Al final de cada fichero, tras la última sección:

```
**Verificado: 2026-10-28** (construida con el repo; sin re-ejecutar en vivo desde entonces).
```

- [ ] **Step 2: Recortar 1 línea de `canarias-datos-abiertos`**

161 → 160 líneas: eliminar la línea en blanco sobrante entre `## Trampas` y su tabla (o la última línea vacía duplicada). Sin tocar contenido.

- [ ] **Step 3: Ejecutar el script contra el repo real**

Run: `bash scripts/check-skills.sh`
Expected: `check-skills: 7 skills, 0 errores, 0 avisos`.

- [ ] **Step 4: Commit**

```bash
git add skills/canarias-datos-abiertos/SKILL.md skills/canarias-datos-publicos-playbook/SKILL.md skills/canarias-transparencia-portal/SKILL.md
git commit -m "fix: marca Verificado y límite de líneas en las skills canarias"
```

---

### Task 3: Workflow de GitHub Actions

**Files:**
- Create: `.github/workflows/validate-skills.yml`

**Interfaces:**
- Consumes: `scripts/check-skills.sh`, `Flash-Brew-Digital/validate-skill@v1`.
- Produces: job `spec` (matriz) y job `repo-rules`, ambos obligatorios.

- [ ] **Step 1: Escribir el workflow**

```yaml
name: validate-skills

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  spec:
    name: spec (${{ matrix.skill }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        skill: [canarias-datos-abiertos, canarias-datos-publicos-playbook,
                canarias-transparencia-portal, ckan, doue-ted, mantenimiento, placsp]
    steps:
      - uses: actions/checkout@v4
      - name: Validate SKILL.md (Agent Skills spec)
        uses: Flash-Brew-Digital/validate-skill@v1
        with:
          path: ./skills/${{ matrix.skill }}
          validate-references: "true"

  repo-rules:
    name: repo-rules
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Reglas del repo (estilo, Verificado, índice, enrutado, fugas)
        run: bash scripts/check-skills.sh "$GITHUB_WORKSPACE"
      - name: El script y su test se ejecutan sin dependencias
        run: bash scripts/test-check-skills.sh
```

- [ ] **Step 2: Validar el YAML en local**

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/validate-skills.yml"); puts "YAML ok"'`
Expected: `YAML ok`. (Si no hay ruby: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/validate-skills.yml')); print('YAML ok')"`.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/validate-skills.yml
git commit -m "ci: validación de skills en PR y push a main"
```

---

### Task 4: Documentación y sincronización

**Files:**
- Modify: `README.md` (sección de desarrollo: cómo correr el CI en local)
- Modify: `skills/mantenimiento/SKILL.md` (receta 5: el grep manual pasa a `bash scripts/check-skills.sh`)
- Modify: `docs/superpowers/specs/2026-10-30-ci-validacion-skills-design.md` (estado: aprobado)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: documentación que no contradice el CI.

- [ ] **Step 1: README — una línea con el comando**

Añadir donde el README explique la estructura: `bash scripts/check-skills.sh && bash scripts/test-check-skills.sh` valida lo mismo que el CI, sin red.

- [ ] **Step 2: `mantenimiento` receta 5 — sustituir el grep manual**

Reemplazar el `git grep` obligatorio por: "`bash scripts/check-skills.sh` (cubre los greps de filtración con su exención; si sale 1, no hay push)". Actualizar la marca **Verificado** de `mantenimiento` con la fecha del cambio.

- [ ] **Step 3: Verificación final**

Run: `bash scripts/check-skills.sh; bash scripts/test-check-skills.sh; git status --short`
Expected: `0 errores` y `TEST GREEN`, y `git status` sin cambios pendientes tras commit.

- [ ] **Step 4: Sync global (receta 4)**

`cp skills/<skill>/SKILL.md ~/.claude/skills/<skill>/SKILL.md` para las skills tocadas y `diff -q` para probar igualdad.

- [ ] **Step 5: Commit**

```bash
git add README.md skills/mantenimiento/SKILL.md docs/superpowers/specs/2026-10-30-ci-validacion-skills-design.md
git commit -m "docs: cómo validar las skills en local y en CI"
```
