#!/usr/bin/env bash
# Test de fixtures para scripts/check-skills.sh (sin dependencias, sin red).
# Uso: bash scripts/test-check-skills.sh   → "TEST GREEN" y exit 0
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/check-skills.sh"
FAILS=0
TOTAL=0

make_root() {  # imprime la ruta de un repo mínimo con una skill válida
  local R
  R="$(mktemp -d)"
  mkdir -p "$R/skills/demo"
  cat > "$R/skills/demo/SKILL.md" <<'EOF'
---
name: demo
description: "Use when hay que probar el validador del repo."
---

# Demo

**Idea central:** una skill de prueba.

## Mapa real

| URL | Qué devuelve |
|---|---|
| `/x` | nada |

## Trampas

| Síntoma | Realidad |
|---|---|
| a | b |

## Controles y revisión adversarial

1. Cuenta.

**Verificado: 2026-10-30**
EOF
  cat > "$R/skills/README.md" <<'EOF'
# Skills

| Skill | Uso |
|---|---|
| `demo` | probar |
EOF
  cat > "$R/AGENTS.md" <<'EOF'
# AGENTS

| Tarea | Skill |
|---|---|
| probar | `demo` |
EOF
  echo "$R"
}

expect() {  # expect <exit> <substring> <root> <descripción>
  local out code
  out="$("$SCRIPT" "$3" 2>&1)"; code=$?
  TOTAL=$((TOTAL+1))
  if [ "$code" -ne "$1" ] || ! printf '%s' "$out" | grep -qF -- "$2"; then
    echo "FALLO [${4:-}]: esperaba exit $1 con '$2', salió $code"
    printf '%s\n' "$out" | sed 's/^/    /'
    FAILS=$((FAILS+1))
  else
    echo "ok  ${4:-}"
  fi
}

R="$(make_root)"
expect 0 "0 errores" "$R" "fixture válido"

R="$(make_root)"; printf '\n**Verificado: 2099-01-01**\n' >> "$R/skills/demo/SKILL.md"
expect 1 "futura" "$R" "fecha de verificación futura"

R="$(make_root)"; perl -pi -e 's/^\*\*Verificado.*$//' "$R/skills/demo/SKILL.md"
expect 1 "Verificado" "$R" "sin marca Verificado"

R="$(make_root)"; perl -pi -e 's/^## Trampas$/## Otra cosa/' "$R/skills/demo/SKILL.md"
expect 1 "trampas" "$R" "sin sección de trampas"

R="$(make_root)"; perl -pi -e 's/^## Controles y revisión adversarial$/## Notas/' "$R/skills/demo/SKILL.md"
expect 1 "controles" "$R" "sin sección de controles"

R="$(make_root)"; printf '\nContacto: alguien@gmail.com\n' >> "$R/skills/demo/SKILL.md"
expect 1 "fuga" "$R" "correo personal en una skill"

R="$(make_root)"; mv "$R/skills/demo" "$R/skills/mantenimiento"
perl -pi -e 's/^name: demo/name: mantenimiento/' "$R/skills/mantenimiento/SKILL.md"
perl -pi -e 's/`demo`/`mantenimiento`/' "$R/skills/README.md"
printf '\n- Receta: `git grep -n "/Users/\\|_API_KEY=\\|@gmail.com"`\n' >> "$R/skills/mantenimiento/SKILL.md"
expect 0 "0 errores" "$R" "la receta git grep queda exenta en mantenimiento"

R="$(make_root)"; mkdir -p "$R/skills/huerfana"
sed 's/^name: demo/name: huerfana/' "$R/skills/demo/SKILL.md" > "$R/skills/huerfana/SKILL.md"
expect 1 "huérfana" "$R" "skill fuera del índice"

R="$(make_root)"; perl -pi -e 's/^description:.*$/description: "Validar cosas."/' "$R/skills/demo/SKILL.md"
expect 1 "Use when" "$R" "description sin disparador"

R="$(make_root)"; perl -pi -e 's/^\*\*Idea central.*$//' "$R/skills/demo/SKILL.md"
expect 1 "Idea central" "$R" "sin idea central en negrita"

R="$(make_root)"; for i in $(seq 1 200); do echo "relleno $i" >> "$R/skills/demo/SKILL.md"; done
expect 1 "líneas" "$R" "más de 160 líneas"

R="$(make_root)"; perl -pi -e 's/^## Mapa real$/## Enrutado por pregunta/' "$R/skills/demo/SKILL.md"
expect 0 "0 errores" "$R" '"Enrutado por pregunta" vale como mapa'

R="$(make_root)"; perl -pi -e 's/^## Mapa real$/## Gramática de URLs/' "$R/skills/demo/SKILL.md"
expect 0 "0 errores" "$R" '"Gramática de URLs" vale como mapa'

R="$(make_root)"; perl -pi -e 's/^## Controles y revisión adversarial$/## Antes de dar un dato por bueno/' "$R/skills/demo/SKILL.md"
expect 0 "0 errores" "$R" '"Antes de dar un dato por bueno" vale como controles'

R="$(make_root)"; mv "$R/skills/demo" "$R/skills/mantenimiento"
perl -pi -e 's/^name: demo/name: mantenimiento/' "$R/skills/mantenimiento/SKILL.md"
perl -pi -e 's/^## Trampas$/## Recetas/' "$R/skills/mantenimiento/SKILL.md"
perl -pi -e 's/`demo`/`mantenimiento`/' "$R/skills/README.md"
expect 0 "0 errores" "$R" "mantenimiento exenta de tabla de trampas"

R="$(make_root)"; perl -pi -e 's/^## Controles y revisión adversarial$/## Contrato de evidencia (no negociable)/' "$R/skills/demo/SKILL.md"
expect 0 "0 errores" "$R" '"Contrato de evidencia" vale como controles'

R="$(make_root)"; printf '\nContacto: alguien@gmail.com (ver git grep en la receta)\n' >> "$R/skills/demo/SKILL.md"
expect 1 "fuga" "$R" "la exención no cubre una skill de datos"

R="$(make_root)"; mkdir -p "$R/examples"; printf '# Ejemplo\n\nRuta: /Users/alguien/privado\n' > "$R/examples/fuga.md"
expect 1 "fuga" "$R" "fuga fuera de skills/ (examples)"

R="$(make_root)"; perl -0pi -e 's/(# Demo\n)/$1\n---\n/' "$R/skills/demo/SKILL.md"
expect 0 "0 errores" "$R" "un --- en el cuerpo no cierra el frontmatter"

R="$(make_root)"; perl -pi -e 's/^description:.*$/description: '"'"'Use when hay que probar el validador.'"'"'/' "$R/skills/demo/SKILL.md"
expect 0 "0 errores" "$R" "description con comillas simples"

R="$(make_root)"
n="$(grep -c '' "$R/skills/demo/SKILL.md")"
for i in $(seq 1 $((161 - n))); do printf 'relleno %s\n' "$i" >> "$R/skills/demo/SKILL.md"; done
perl -0pi -e 's/\n\z//' "$R/skills/demo/SKILL.md"
expect 1 "líneas" "$R" "cuenta la última línea aunque no acabe en salto"

R="$(make_root)"; mkdir -p "$R/skills/datos"
printf '| `canarias-datos-abiertos` | señuelo con el nombre dentro |\n' >> "$R/skills/README.md"
sed 's/^name: demo/name: datos/' "$R/skills/demo/SKILL.md" > "$R/skills/datos/SKILL.md"
expect 1 "huérfana" "$R" "nombre que aparece como subcadena en otra skill"

R="$(make_root)"; mkdir -p "$R/skills/sin-skill"
expect 1 "SKILL.md" "$R" "directorio sin SKILL.md"

R="$(make_root)"; mkdir -p "$R/skills/collision"
printf -- '---\nname: mal\n\n# X\n\nTexto con frontmatter abierto.\n\n---\n\n**Idea central:** x\n' > "$R/skills/collision/SKILL.md"
expect 1 "frontmatter sin cerrar" "$R" "frontmatter abierto y --- tardío en el cuerpo"

R="$(make_root)"
git -C "$R" init -q
mkdir -p "$R/.local-mining"; echo x > "$R/.local-mining/nota.txt"
git -C "$R" add -f .local-mining/nota.txt
expect 1 "trackeado" "$R" ".local-mining trackeado"

echo "----"
if [ "$FAILS" -eq 0 ]; then
  echo "TEST GREEN ($TOTAL casos)"
else
  echo "TEST RED ($FAILS de $TOTAL casos)"
  exit 1
fi
