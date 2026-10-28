# contratacion-transparencia-skills

Skills de agente para investigar **contratación pública española** (PLACSP), **anuncios del DOUE/TED** (UE), **open data en CKAN** y **transparencia de las administraciones** — con todo verificado contra fuentes reales y la disciplina de evidencia que exige el sector: criterio, segunda fuente, fuente primaria.

Nacido del análisis del Gobierno de Canarias (salud/SCS, educación, contratos); útil para cualquier órgano de España y la UE.

## En qué te ayuda (3 capas)

1. **Plataformas genéricas** — comunes a todo el estado/UE:
   - `placsp`: fichas de contratación (contrataciondelestado.es), pliegos (PPT/PCAP), adjudicaciones, retro-cronología vía BOE, PDF ilegible → markdown con Datalab y las trampas (tokens opacos, pliegos anulados, expedientes que se resetean por año...).
   - `doue-ted`: API TED v3 + XML eForms, importes (`PayableAmount`), puente ficha↔anuncio.
   - `ckan`: patrones genéricos de cualquier portal CKAN (descubrir la API real — casi nunca está en la raíz —, datastore vs CSV, topes, codificaciones).
2. **Capa autonómica Canarias**: `canarias-datos-publicos-playbook` (router + contrato de evidencia), `canarias-datos-abiertos` (CKAN/ISTAC de datos.canarias.es), `canarias-transparencia-portal` (portales de transparencia de GobCan).
3. **Enrutado y mantenimiento**: el `AGENTS.md` decide qué capa se carga por origen del órgano/portal; la skill `mantenimiento` (con el agente `mantenedor`) es la rutina del repo. Para otra comunidad autónoma: añade `skills/<comunidad>-<plataforma>` (patrón en `skills/README.md`); bienvenidos. Los `examples/` usan datos generados (ficticios), nunca datos reales de empresas.

## Instalar 

### Clonar y usar (OpenCode — cero pasos)

```bash
git clone https://github.com/jdvr/contratacion-transparencia-skills.git contratacion-transparencia-skills
cd contratacion-transparencia-skills
opencode   # abre la sesión en este directorio; las skills y el AGENTS.md se cargan solos
```

OpenCode encuentra solo las skills (nuestro `opencode.jsonc` declara `"skills": ["./skills"]`) y el `AGENTS.md` se carga como instrucciones. Pregunta y listo.


### Usando skills:

```bash
npx skills add jdvr/contratacion-transparencia-skills   # requiere el repo publicado en GitHub
```

El CLI descubre los `SKILL.md` de este repo y pregunta cuáles instalar y en qué agente (OpenCode, Claude Code, Cursor, Codex…). Diferencia con clonar: `npx skills` solo instala skills en tu agente; clonar el repo además trae el `AGENTS.md` (enrutado + contrato de evidencia), los `examples/` verificados y el agente `mantenedor`.

## Preguntas de ejemplo

- "¿Qué contratos ha adjudicado la sanidad de mi comunidad a un proveedor concreto y cuánto suman?" → `examples/ejemplo-proveedor-por-nif.md` (datos generados)
- "¿Dónde están los pliegos del expediente que me interesa?" → `placsp`
- "¿Se ha modificado ese contrato y por cuánto?" → `doue-ted`
- "¿Cuáles son los presupuestos de 2024 del SCS?" → capa canarias (8 peticiones, test GREEN)

## Uso responsable ⚠️

Estos portales son un **servicio público para toda la ciudadanía**: un uso abusivo los degrada para todos. Con presupuestos de peticiones declarados, espera entre consultas, respeta `robots.txt`, cachea y sin scraping masivo. Quien mejor resulta aquí no es el que más pide, sino el que pide lo correcto.

## Aviso legal

- Los datos con los que trabajan las skills son públicos. Al republicar cifras, aplica la atribución que los portales exigen ("Fuente: Gobierno de Canarias", etc.).
- Los agregadores (LiciRadar, OpenProcurements, concursospublicos.com...) son **fuente secundaria**: se verifican siempre contra PLACSP/BOE/TED/portal oficial.
- Este repo no tiene relación oficial con ninguna de las plataformas: son herramientas de analista ciudadano, sin garantía (CC BY 4.0, véase LICENSE).

## Contribuir

Lee `skills/README.md`: convención de nombres, estilo y el checklist obligatorio (frontmatter, trampas verificadas, controles/adversarial y test adversarial con agente fresco antes de publicar).
