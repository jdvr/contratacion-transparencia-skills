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
TODAY="$(date -u +%Y-%m-%d)"   # UTC: la fecha del runner, no la del portátil

# Fugas de material privado: rutas personales, claves y correos.
LEAK_PATTERN='/Users/|_API_KEY=|@gmail\.com|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}'
# Ruta de la receta que enseña el patrón (no un valor): única línea exenta.
RECIPE_FILE="skills/mantenimiento/SKILL.md"

err()  { printf '::error file=%s,line=%s::%s\n' "$1" "${2:-1}" "$3"; ERRORS=$((ERRORS + 1)); }
warn_msg() { printf '::warning::%s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }

# leak_matches: imprime "ruta:línea:texto" de todo fichero versionado (o del árbol si no hay git).
leak_matches() {
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" grep -nIE -- "$LEAK_PATTERN" 2>/dev/null
  else
    grep -rnIE --exclude-dir=.git --exclude-dir=.superpowers --exclude-dir=.local-mining \
      -- "$LEAK_PATTERN" "$ROOT" 2>/dev/null | sed "s#^$ROOT/##"
  fi
}

# scan_leaks: recorre TODO el árbol publicado, no solo las skills. Un `_API_KEY=`
# pegado en examples/ o en un doc filtra igual que uno en un SKILL.md.
scan_leaks() {
  local hit path rest line text
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    path="${hit%%:*}"
    rest="${hit#*:}"
    line="${rest%%:*}"
    text="${rest#*:}"
    # El detector y la documentación que lo explica citan los patrones a propósito.
    case "$path" in
      scripts/*|docs/superpowers/*) continue ;;
    esac
    # La receta que enseña el patrón no es una fuga. Solo esa línea, en ese fichero.
    if [ "$path" = "$RECIPE_FILE" ]; then
      case "$text" in
        *"git grep"*) continue ;;
      esac
    fi
    # No se imprime el valor: el log de Actions de un repo público también es público.
    err "$path" "$line" "posible fuga de material privado (valor oculto: revísalo en la línea)"
  done < <(leak_matches)
}

check_skill() {
  local file="$1" rel dir fm_end iline mline tline cline vline vdate lines desc dline first

  rel="${file#"$ROOT"/}"
  dir="$(basename "$(dirname "$file")")"
  SKILLS=$((SKILLS + 1))

  # 1. Frontmatter presente y cerrado en las primeras líneas (un `---` del cuerpo
  #    no es el cierre: es un separador markdown).
  fm_end=0
  if [ "$(sed -n '1p' "$file")" = "---" ]; then
    fm_end="$(awk 'NR > 1 && NR <= 6 && /^---[[:space:]]*$/ {print NR; exit}' "$file")"
    if [ -z "$fm_end" ]; then
      err "$rel" 1 "frontmatter sin cerrar en las 6 primeras líneas"
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
      desc="$(sed -n "${dline}p" "$file" | sed 's/^description:[[:space:]]*//' | tr -d "\"'" | sed 's/[[:space:]]*$//')"
      case "$desc" in
        "Use when"*) ;;
        *) err "$rel" "$dline" 'description debe empezar por "Use when" (disparadores de enrutado)' ;;
      esac
    fi

    # 3. Primer párrafo del cuerpo en negrita (la idea central).
    #    Se saltan encabezados y reglas horizontales (`---`) del cuerpo.
    iline="$(awk -v s="$fm_end" 'NR > s && NF && $0 !~ /^#/ && $0 !~ /^---+[[:space:]]*$/ {print NR; exit}' "$file")"
    if [ -z "$iline" ]; then
      err "$rel" "$fm_end" "cuerpo vacío tras el frontmatter"
    else
      first="$(sed -n "${iline}p" "$file")"
      case "$first" in
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

  # 8. Límite de líneas (regla 5 de estilo: ≤ 160). `grep -c ''` cuenta también
  #    la última línea si el fichero no acaba en salto de línea; `wc -l` no.
  lines="$(grep -c '' "$file")"
  if [ "$lines" -gt "$MAX_LINES" ]; then
    err "$rel" 1 "tiene $lines líneas (máximo $MAX_LINES)"
  fi
}

# --- Skills: se recorren los directorios, no solo los SKILL.md existentes,
#     para que un directorio sin SKILL.md no pase invisible ---
for d in "$ROOT"/skills/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  if [ ! -f "$d/SKILL.md" ]; then
    err "skills/$name/SKILL.md" 1 "directorio sin SKILL.md"
    continue
  fi
  check_skill "$d/SKILL.md"
done

# --- Coherencia índice / enrutado: se exige el nombre entre backticks, como
#     aparece en las tablas; una subcadena ("datos" dentro de "canarias-datos-abiertos")
#     no cuenta como entrada. ---
for d in "$ROOT"/skills/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  grep -qF -- "\`$name\`" "$ROOT/skills/README.md" 2>/dev/null || \
    err "skills/README.md" 1 "skill huérfana: \`$name\` no está en la tabla índice"
  if [ "$name" != "mantenimiento" ]; then
    grep -qF -- "\`$name\`" "$ROOT/AGENTS.md" 2>/dev/null || \
      err "AGENTS.md" 1 "skill huérfana: \`$name\` no figura en el enrutado de AGENTS.md"
  fi
done

# --- Fugas en TODO el árbol publicado ---
scan_leaks

# --- Material local fuera del repo ---
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$ROOT" ls-files --error-unmatch .local-mining >/dev/null 2>&1; then
    err ".local-mining" 1 "material local trackeado: .local-mining debe quedar fuera del repo"
  fi
else
  warn_msg "git no disponible en $ROOT: no se pudo comprobar si .local-mining está trackeado"
fi

printf 'check-skills: %s skills, %s errores, %s avisos\n' "$SKILLS" "$ERRORS" "$WARNINGS"
if [ "$ERRORS" -eq 0 ]; then
  exit 0
fi
printf 'Revisa los ::error anteriores.\n'
exit 1
