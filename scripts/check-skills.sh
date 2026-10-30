#!/usr/bin/env bash
# Valida las reglas propias de este repo sobre skills/*/SKILL.md.
# La conformidad con la especificación Agent Skills (frontmatter YAML, name = directorio,
# longitud de description, campos opcionales) la comprueba la acción
# Flash-Brew-Digital/validate-skill en CI; aquí solo lo que esa spec no cubre.
#
# Uso: bash scripts/check-skills.sh [raíz-del-repo]
# Salida: anotaciones ::error file=…,line=…::mensaje + resumen. Exit 1 si hay errores.
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ROOT="$(cd "$ROOT" && pwd)"

ERRORS=0
WARNINGS=0
SKILLS=0
MAX_LINES=160
TODAY="$(date +%Y-%m-%d)"

# Fugas de material privado: rutas personales, claves y correos.
LEAK_PATTERN='/Users/|_API_KEY=|@gmail\.com|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}'

err()  { printf '::error file=%s,line=%s::%s\n' "$1" "${2:-1}" "$3"; ERRORS=$((ERRORS + 1)); }
warn() { printf '::warning file=%s,line=%s::%s\n' "$1" "${2:-1}" "$3"; WARNINGS=$((WARNINGS + 1)); }

# scan_leaks <ruta relativa>: marca líneas con material privado.
# Excepción: las líneas que contienen "git grep" son la receta que enseña el patrón,
# no un valor; sin esta exención el repo se denuncia a sí mismo.
scan_leaks() {
  local rel="$1" abs="$ROOT/$1" hit line text
  [ -f "$abs" ] || return 0
  while IFS= read -r hit; do
    line="${hit%%:*}"
    text="${hit#*:}"
    case "$text" in
      *"git grep"*) continue ;;
    esac
    err "$rel" "$line" "posible fuga de material privado: ${text:0:70}"
  done < <(grep -nE "$LEAK_PATTERN" "$abs")
}

check_skill() {
  local file="$1" rel dir fm_end first_first iline mline tline cline vline vdate lines desc dline

  rel="${file#"$ROOT"/}"
  dir="$(basename "$(dirname "$file")")"
  SKILLS=$((SKILLS + 1))

  # 1. Frontmatter presente y cerrado.
  fm_end=0
  if [ "$(sed -n '1p' "$file")" = "---" ]; then
    fm_end="$(awk 'NR > 1 && /^---[[:space:]]*$/ {print NR; exit}' "$file")"
    if [ -z "$fm_end" ]; then
      err "$rel" 1 "frontmatter sin cerrar (falta la línea --- final)"
      fm_end=0
    fi
  else
    err "$rel" 1 "falta el frontmatter (la primera línea debe ser ---)"
  fi

  # 2. description empieza por "Use when": es la superficie de enrutado.
  if [ "$fm_end" -gt 0 ]; then
    dline="$(grep -n '^description:' "$file" | head -1 | cut -d: -f1)"
    if [ -z "$dline" ]; then
      err "$rel" 1 "falta description en el frontmatter"
    else
      desc="$(sed -n "${dline}p" "$file" | sed 's/^description:[[:space:]]*//; s/^"//; s/"$//')"
      case "$desc" in
        "Use when"*) ;;
        *) err "$rel" "$dline" 'description debe empezar por "Use when" (disparadores de enrutado)' ;;
      esac
    fi

    # 3. Primer párrafo del cuerpo en negrita (la idea central).
    iline="$(awk -v s="$fm_end" 'NR > s && NF && $0 !~ /^#/ {print NR; exit}' "$file")"
    if [ -z "$iline" ]; then
      err "$rel" "$fm_end" "cuerpo vacío tras el frontmatter"
    else
      case "$(sed -n "${iline}p" "$file")" in
        '**'*) ;;
        *) err "$rel" "$iline" "Idea central: el primer párrafo del cuerpo debe abrir con **...**" ;;
      esac
    fi
  fi

  # 4. Mapa real de URLs: el nombre de la sección depende del oficio de la skill
  #    (mapa de URLs, enrutado entre portales o gramática de rutas). Se aceptan las tres.
  mline="$(grep -nE '^## Mapa real|^## Enrutado por pregunta|^## Gramática de URLs' "$file" | head -1 | cut -d: -f1)"
  [ -n "$mline" ] || err "$rel" 1 'falta el mapa de URLs ("## Mapa real", "## Enrutado por pregunta" o "## Gramática de URLs")'

  # 5. Tabla de trampas. `mantenimiento` es una skill de proceso, no de datos:
  #    no tiene trampas de portal que documentar, así que está exenta.
  if [ "$dir" != "mantenimiento" ]; then
    tline="$(grep -nE '^## Trampas|^## Señales de que te estás equivocando' "$file" | head -1 | cut -d: -f1)"
    [ -n "$tline" ] || err "$rel" 1 'falta la tabla de trampas ("## Trampas" o "## Señales de que te estás equivocando")'
  fi

  # 6. Controles y revisión adversarial: el playbook los llama "contrato de evidencia",
  #    las skills canarias de datos "antes de dar un dato por bueno".
  cline="$(grep -nE '^## Controles y revisión adversarial|^## Antes de dar un dato por bueno|^## Contrato de evidencia' "$file" | head -1 | cut -d: -f1)"
  [ -n "$cline" ] || err "$rel" 1 'falta la sección de controles ("## Controles y revisión adversarial", "## Antes de dar un dato por bueno" o "## Contrato de evidencia")'

  # 7. Marca "Verificado: YYYY-MM-DD", con ninguna fecha en el futuro.
  vline="$(grep -nE '^\*\*Verificado: [0-9]{4}-[0-9]{2}-[0-9]{2}' "$file" | head -1 | cut -d: -f1)"
  if [ -z "$vline" ]; then
    err "$rel" 1 'falta la marca "**Verificado: YYYY-MM-DD**" al cierre'
  else
    while IFS= read -r vmatch; do
      vdate="$(printf '%s\n' "${vmatch#*:}" | sed -E 's/.*Verificado: ([0-9]{4}-[0-9]{2}-[0-9]{2}).*/\1/')"
      if [ "$vdate" \> "$TODAY" ]; then
        err "$rel" "${vmatch%%:*}" "fecha de verificación futura ($vdate > $TODAY)"
      fi
    done < <(grep -nE '^\*\*Verificado: [0-9]{4}-[0-9]{2}-[0-9]{2}' "$file")
  fi

  # 8. Límite de líneas (regla 5 de estilo: ≤ 160).
  lines="$(wc -l < "$file" | tr -d ' ')"
  if [ "$lines" -gt "$MAX_LINES" ]; then
    err "$rel" 1 "tiene $lines líneas (máximo $MAX_LINES)"
  fi

  # 9. Fugas dentro de la skill.
  scan_leaks "$rel"
}

# --- Skills ---
for file in "$ROOT"/skills/*/SKILL.md; do
  [ -f "$file" ] || continue
  check_skill "$file"
done

# --- Coherencia índice / enrutado ---
for d in "$ROOT"/skills/*/; do
  name="$(basename "$d")"
  grep -qF -- "$name" "$ROOT/skills/README.md" || \
    err "skills/README.md" 1 "skill huérfana: $name no está en la tabla índice"
  if [ "$name" != "mantenimiento" ]; then
    grep -qF -- "$name" "$ROOT/AGENTS.md" || \
      err "AGENTS.md" 1 "skill huérfana: $name no figura en el enrutado de AGENTS.md"
  fi
done

# --- Fugas en los ficheros que enrutan ---
scan_leaks "skills/README.md"
scan_leaks "AGENTS.md"
scan_leaks "README.md"

# --- Material local fuera del repo ---
if git -C "$ROOT" ls-files --error-unmatch .local-mining >/dev/null 2>&1; then
  err ".gitignore" 1 "material local trackeado: .local-mining debe quedar fuera del repo"
fi

printf 'check-skills: %s skills, %s errores, %s avisos\n' "$SKILLS" "$ERRORS" "$WARNINGS"
if [ "$ERRORS" -eq 0 ]; then
  exit 0
fi
printf 'Revisa los ::error anteriores.\n'
exit 1
