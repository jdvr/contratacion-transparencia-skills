# Skills de contratación y transparencia pública

Skills para agentes que exploran, recogen y analizan datos públicos de contratación y transparencia. Cada skill es un único `SKILL.md` (descubierto automáticamente por OpenCode cuando apunta a este repo, o copiable a los directorios globales).

## Índice

| Skill | Uso para | Verificado |
|---|---|---|
| `canarias-datos-publicos-playbook` | Enruta cualquier pregunta de datos públicos (GobCan) y el contrato de evidencia | 2026-10 (tests GREEN educativo/SCS) |
| `canarias-datos-abiertos` | datos.canarias.es (CKAN/ISTAC): presupuestos, contratos, listas de espera, centros | 2026-10 (baseline/GREEN) |
| `canarias-transparencia-portal` | gobiernodecanarias.org/transparencia: fichas, PDFs/XLSX, retribuciones, RPT | 2026-10 (baseline/GREEN) |
| `placsp` | PLACSP (contrataciondelestado.es): fichas, pliegos, adjudicaciones — cualquier órgano de España | 2026-10-28 (fichas en vivo) |
| `doue-ted` | DOUE serie S / TED: anuncios UE, modificaciones, importes eForms | 2026-10-28 (API v3 + XML en vivo) |
| `ckan` | Patrones genéricos de CKAN (reutilizable en cualquier portal que lo use) | 2026-10-28 (instancia GobCan) |
| `mantenimiento` | Rutina del repo: añadir/actualizar/verificar/sincronizar skills (la usa el agente `mantenedor`) | 2026-10-28 (repo construido con ella) |

## Capas y convención de nombres

1. **Genérica de plataforma**: `placsp`, `doue-ted`, `ckan` — valen para todo el estado español / UE / cualquier portal CKAN. Nacieron de la experiencia canaria pero no suponen Canarias.
2. **Capa autonómica**: skills con el patrón **`[comunidad]-[plataforma]`** (kebab-case, exactamente dos elementos): `[comunidad]` = comunidad autónoma en minúscula sin acentos (`canarias`, `andalucia`, `navarra`...); `[plataforma]` = el nombre de la plataforma o portal tal como lo llama la skill genérica correspondiente (`datos-abiertos`, `transparencia-portal`...). Ejemplos válidos: `canarias-datos-abiertos`, `andalucia-transparencia-portal`, `navarra-escritorio-de-contratacion` (si existe tal portal). Las skills **genéricas de plataforma** llevan solo ese nombre (`placsp`, `doue-ted`, `ckan`) — esa es la otra mitad del patrón: si tu recurso es común a todo el estado, no le pongas comunidad. Y cada comunidad routera lleva el patrón completo: `<comunidad>-datos-publicos-playbook` (hoy: `canarias-datos-publicos-playbook`).
3. **Enrutado**: el `AGENTS.md` de la raíz y `canarias-datos-publicos-playbook` deciden qué capa se carga por origen del órgano/portal. Al añadir una skill autonómica, actualiza ambas tablas de enrutado.

## Estilo canarias (las 5 reglas)

1. Frontmatter: `name` = nombre del directorio y `description` "Use when..." con disparadores y señales de fallo explícitas (es la superficie de enrutado).
2. Idea central en negrita como primer párrafo: el modelo mental que evita el error n.º 1.
3. Tabla "mapa real" con URLs/base verificadas y qué devuelve cada una.
4. Recetas copy-pasteables con salida esperada (`# → 22`), y tabla de Trampas `Síntoma | Realidad` — cada fila con caso real, nunca teórica.
5. Cierre: sección de controles/adversarial (ver abajo) + marca **Verificado: fecha** (y qué se probó). ≤ 160 líneas.

## Checklist para añadir una skill (obligatorio)

- [ ] Ruta real descubierta y re-verificada hoy (`curl`/`webfetch` con respuesta citada).
- [ ] Tabla de trampas con filas de casos reales (fallo ocurrido, no suposición).
- [ ] Sección **Controles y revisión adversarial** adaptada al dominio: contar vs declarado, segunda fuente, contenedor/encoding, criterio del total, intento de falsificar tu propia cifra, cobertura declarada, etiquetas honestas.
- [ ] **Test adversarial GREEN con agente fresco**: subagente sin la skill (línea base) y otro con la skill, misma tarea; compara peticiones y callejones; y una pasada que busque errores de la propia skill ("¿qué dato de esta skill está mal o desactualizado?"). Corrige lo detectado antes del commit (metodología de la validación 2026-10: con skills, 8 peticiones y cero callejones; la validación encontró 4 errores a corregir).
- [ ] Marca "Verificado" con fecha; lo no re-ejecutado se marca como tal.
- [ ] Sin rutas personales, claves o material confidencial, y  **sin datos reales de empresas**: los ejemplos usan datos generados etiquetados como ficticios.
- [ ] Actualiza la tabla de enrutado (AGENTS.md y playbook si procede).

## Uso responsable

Estos portales son un servicio público para toda la ciudadanía: presupuestos de peticiones declarados, espera entre consultas, respeta `robots.txt` y límites, cachea lo descargado, no scraping masivo. La calidad del análisis no nace de pedir más peticiones, sino de pedir las correctas.
