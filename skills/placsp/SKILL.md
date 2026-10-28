---
name: placsp
description: "Use when hay que localizar, leer o verificar expedientes de contratación en PLACSP (contrataciondelestado.es): fichas de licitación, adjudicaciones, formalizaciones, pliegos (PPT/PCAP), cualquier órgano de contratación de España. Imprescindible cuando la búsqueda interna del portal no encuentra un expediente que existe, cuando un token o URL de la ficha da error, o cuando hay que citar un dato en fuente primaria en lugar de un agregador."
---

# PLACSP — Plataforma de Contratación del Sector Público (estatal: cualquier órgano de España)

**PLACSP no es API-first: es una gramática de navegación.** Los formatos de número de expediente varían por órgano (`19/T/...` es del SCS; Castilla y León usa otros): el token `idEvl` opaco es la única clave estable entre portales. websearch/agregador para encontrar el token → ficha deeplink con `idEvl` → documentos (servlet o UUID dentro del cuadro de características) → citar fuente primaria. La búsqueda interna del portal es débil: un expediente puede existir y no aparecer — el fallo es de la búsqueda, no del portal. Los tokens de los deep-links son **opacos y URL-encoded**: cópialos tal cual (`%2F`, `%2B`, `%3D`), sin decodificar, o PLACSP los dará por inválidos. `contrataciondelestado.es` **rechaza curl** (código 000): usa `webfetch` o navegador.

## Mapa real (URLs base ↔ qué devuelve)

| Tipo | URL | Qué devuelve |
|---|---|---|
| Ficha de licitación | `https://contrataciondelestado.es/wps/poc?uri=deeplink:detalle_licitacion&idEvl=<token>` | expediente, órgano, estado, importes, adjudicatario, tabla de anuncios y documentos |
| Perfil del contratante | `.../uri=deeplink:perfilContratante&idBp=<token>` | central del órgano (aparece dentro del cuadro de pliegos) |
| Documento por servlet | `https://contrataciondelestado.es/FileSystem/servlet/GetDocumentByIdServlet?cifrado=...&DocumentIdParam=...` | HTML o PDF según el documento; el mismo `cifrado` sirve a todo un órgano |
| Documento por UUID | `https://contrataciondelestado.es/wps/wcm/connect/PLACE_es/Site/area/docAccCmpnt?...&DocumentIdParam=<UUID>` | pliegos reales (PPT/PCAP) enlazados dentro del "Documento de Pliegos" |
| BOE (histórico) | `https://www.boe.es/diario_boe/txt.php?id=BOE-B-<AAAA>-<N>` | adjudicaciones antiguas que la ficha ya no enlaza |

Ejemplos: **el repo no publica datos reales de empresas ni tokens reales** (higiene: los ejemplos usan datos generados; se explican en `examples/`). Verificado en vivo el 2026-10-28 contra fichas reales, con este esquema (valores omitidos): `idEvl=<token>` → ficha <expediente>, <órgano>, <adjudicatario>, <importe adjudicado>, <estado>.

## Recetas

1. **De la noticia al expediente**: cifra exacta y fecha de la nota de prensa → `websearch` del texto + órgano → nota oficial (`www3.gobiernodecanarias.org/noticias/…` o el boletín del órgano) → buscar el expediente por su número o por objeto en agregadores (LiciRadar, OpenProcurements, concursospublicos.com) para obtener el `idEvl` → **verificar en la ficha PLACSP**. Nunca citar el agregador: es fuente secundaria.
2. **Retro-cronología (contratos pre-2020)**: PLACSP no siempre resuelve años antiguos. Entra por BOE: busca `websearch "BOE-B-<AAAA>..." <objeto> <órgano>` y sondea IDs adyacentes (`...37385`, `...37386` suelen ser AE y AP del mismo día).
3. **Descargar pliegos**: la tabla de anuncios de la ficha enlaza el "Documento de Pliegos", que suele ser el **cuadro de características**; los PPT/PCAP reales van como enlaces UUID dentro de ese cuadro. Descárgalos y si el PDF no es legible por `webfetch` (`application/pdf`), conviértelo (receta 4).
4. **PDF de pliegos → markdown con Datalab** (histórico: de sesiones, no re-ejecutado hoy; API de pago, exige `DATALAB_API_KEY` en el entorno — nunca en ficheros): CLI local: `datalab convert --format markdown <fichero.pdf>` (sube el PDF a `POST https://www.datalab.to/api/v1/convert`, sondea, guarda el `.md` junto al original). Vía URL: la API acepta `file_url` (ingesta directa) y devuelve `request_check_url` para el sondeo. Trampa de entorno documentada: un `brotlipy` viejo encima del módulo `brotli` rompe la descarga con `ClientPayloadError 400 "Can not decode content-encoding: br"`; arreglo: borrar el paquete `brotli/` y el egg-info de brotlipy (sin dist-info, `pip uninstall` no basta) y `pip install -U Brotli`. Uso: conversión punto-a-punto de documentos que vas a citar, no crawlers. Después relees el `.md` con grep/por secciones para citar cláusula y página ("PCAP, cláusula 28.2.2" — ejemplo).
5. **Expediente no aparece en la búsqueda del portal**: usa agregadores para el token y vuelve a la ficha; o desciende desde el Perfil del Contratante del órgano.

## Trampas

| Síntoma | Realidad |
|---|---|
| curl a contrataciondelestado.es → exit 000 | El sitio bloquea curl; usa `webfetch` o navegador |
| Ficha "no encontrada" con token copiado | El token se decodificó (`+`→` `, `/`→error); pégalo URL-encoded tal cual |
| El expediente existe pero la búsqueda no lo muestra | Fallo de la búsqueda interna del portal; vía agregador + deep-link |
| "Pliego" en la ficha no trae condiciones | Es el "Documento de Pliegos" = cuadro de características; los pliegos reales van por UUID dentro |
| Dos contrataciones distintas parecen la misma | Los números de expediente se resetean por año; el año va en el 3er bloque (`19/T/AA/...`); busca el expediente completo |
| La carta de adjudicación dice A y el título N (o viceversa) | La letra de procedimiento (abierto/negociado) cambia en tramitación; confía en lo que dice el documento actual |
| PDF del pliego con fecha antigua | Mira "Anuncios Anulados" en la ficha: los pliegos se anulan y se repiten (ejemplo generado: anulado el 20/09/2024, repuesto el 23/09) |
| "Resuelta" sin adjudicatario | Puede estar "licitado" aún: no infieras ganador de un estado parcial |
| Valor estimado distinto al del PCAP | La ficha se actualiza; el PCAP es el documento de la sesión (caso real observado, cifras generadas aquí: ficha <V1> hoy vs <V2> en PCAP) — cita fuente y fecha |
| Nombres de proveedor no aparecen en datasets | El dataset traía solo `adjudicataria_nif`; la razón social solo sale en la ficha PLACSP |
| Producto ≠ empresa | El objeto nombra el producto (la suite clínica contractada), no al fabricante; el mantenimiento del mismo producto lo reparten varias empresas |
| Alias falsos | Siglas falsas amigas: el acrónimo del proveedor pega con otras entidades; usa el NIF, no la sigla |
| NIF corruptos en fuentes | Valida formato (letra + 8 dígitos) antes de hacer joins |
| Importes "1.800.000,00" vs "1800000.00" | Formatos locales en la ficha (ejemplo generado); normaliza antes de sumar o comparar |
| Suma con criterio mezcla | Un total = un criterio: adjudicado, o estimado, o PB, con/sin IGIC; nunca mezclado |
| 1 licitador + negociado | El "Negociado sin publicidad" suele basarse en exclusividad: busca la "Memoria de exclusividad" en Otros Documentos |
| Oferta fuera de plazo "vencida" | PLACSP marca plazos en **hora peninsular**, no en la del interesado (aviso literal del cuadro de pliegos) |
| Rectificado ≠ expediente original | Los anuncios rectificados refieren a otro expediente (o a la anulación de un lote); imprime siempre "Número de Expediente" como primera línea de verificación |

## Historia de tokens/fichas conocidas (ejemplos de trabajo; re-verifica in vivo cuando importe)

- Ejemplo (ficticio) del flujo completo: ficha del expediente `SS/T/24/ZZ/CO/A/0001` → en la tabla de anuncios, "Documento de Pliegos" (cuadro de características) → dentro, UUID `<id>` del PPT y `<id-2>` del PCAP vía `docAccCmpnt` → sección "Anuncios Anulados" cuando un pliego se retira y repone.
- Modificación de contrato (ficticia): +100.000,00 € publicada como anuncio en TED, notice `<N>-<AÑO>` — ver skill `doue-ted`.

## Controles y revisión adversarial (obligatorios)

1. **Cuenta y contrasta**: el dato clave (importe, ganador) se lee en la ficha Y en su documento fuente (anuncio de formalización, PCAP). Si la ficha y el documento difieren, cita ambos con su fecha (la ficha es un estado vivo).
2. **Segunda fuente**: BOE para históricos, TED para anuncios/modificaciones, notas oficiales del órgano. Un agregador es una pista, nunca un resultado.
3. **Contenedor**: un 200 puede devolver la página genérica del portal; busca el texto "Número de Expediente" textual antes de parsear.
4. **Criterio explícito**: al sumar contratos de un grupo define el criterio primero (por NIF, por objeto de la licitación, por lote) y dilo.
5. **Adversarial**: intenta falsificar tu conclusión (busca la licitación que excluya tu resultado: pregunta por el expediente previo y el siguiente, las prórrogas y las rectificaciones); declara cobertura (qué expedientes/años buscaste y qué no); etiqueta VERIFICADO / HIPÓTESIS / NO CONCLUYENTE. Pregunta si esta skill está desactualizada: las gramáticas de PLACSP cambian poco pero cambian.

**Verificado: 2026-10-28 en vivo** con fichas reales (datos de empresa/importes no publicados en este repo por higiene); servlet GetDocumentByIdServlet del pliego 0016; resto: patrones de sesiones 2026-10).

Antes de dar un dato por bueno: URL/token exacto, órgano + expediente, documento fuente del dato, criterio del total, contraste con segunda fuente, bandera de estado (resuelto/licitado), fecha de consulta.
