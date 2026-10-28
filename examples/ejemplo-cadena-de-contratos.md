# Ejemplo (datos generados): la cadena de contratos de una historia clínica autonómica (2013→futuro)

Ejemplo compilado para enseñar el **método**: cómo una única cifra grande (el gasto
autorizado de una "historia clínica unificada") se inscribe en una cadena de contratos
plurianuales. **Todos los datos de empresa, expedientes e importes son GENERADOS
(ficticios, marcados)**; la estructura de fuentes (PLACSP, BOE, TED, notas oficiales,
Cámara de Cuentas) es la real que se usa.

Formato: Periodo | Expediente | Importe | Adjudicataria | Fuente | Estado. Etiquetas:
[VERIFICADO] / [HIPÓTESIS] / [PENDIENTE] según la fuente primaria (aquí, sobre datos generados).

## La cadena (empresas ficticias: "ProSalud Sistemas, S.L.U.", "SistemasSalvia, S.L.U.", "El Mantedor S.A.", "La Integradora, S.L.", y una UTE; servicio de salud ficticio "SS-Atlántida")

| Período | Expediente (fict.) | Importe (fict.) | Adjudicataria (fict.) | Fuente | Estado |
|---|---|---|---|---|---|
| 2013-2016 (licitación 2013, 3 lotes) | `SS/T/13/ZZ/CO/A/0073` | estimado 6.800.000 € | — (lotes repartidos; ver BOE) | BOE <id-anuncio> | [PENDIENTE desglose por lote] |
| 2018 | `SS/T/18/ZZ/DI/A/0019` | 950.000 € (est. 1.990.000 €) | SistemasSalvia (suite AE + módulo) | agregador + ficha | [VERIFICADO oficial] |
| 2018 | `SS/T/18/ZZ/DI/A/0021` | 880.000 € (est. 1.790.000 €) | Otra empresa (módulo de AP) | idem | [VERIFICADO oficial] |
| 2020 | `SS/T/20/ZZ/SE/N/0027` | 145.000 € | — evolutivos de contingencia | informe de control | [VERIFICADO secundaria] |
| 2020 | `SS/T/20/ZZ/CO/A/0045` | 1.120.000 € | SistemasSalvia (suite AE) | open data + ficha | [VERIFICADO] |
| 2020 | `SS/T/20/ZZ/CO/A/0054` | 1.000.000 € | UTE temporal (módulo de AP) | open data + ficha | [VERIFICADO] |
| 2021 | `SS/T/21/ZZ/CO/N/0097` | 1.400.000,10 € (est. 5.180.000 €) | ProSalud Sistemas, S.L.U. | ficha + open data | [VERIFICADO] (modificación de +100.000 € en 2024) |
| 2022 | `SS/T/22/ZZ/CO/A/0034` | 1.120.000 € | El Mantedor S.A. (hospitales) | open data + ficha | [VERIFICADO] |
| 2023 | `SS/T/23/ZZ/CO/A/0017` | Lote 1: 1.740.000 € (VE lote 4.980.000 €) | La Integradora, S.L. (mesa de ayuda) | ficha + rectificado | [VERIFICADO; Lote 2 eliminado en el rectificado] |
| 2024 | `SS/T/24/ZZ/CO/A/0016` | 1.280.000 € (PB 1.640.000 €; 12+36 meses) | El Mantedor S.A. (mantenimiento) | ficha + PCAP | [VERIFICADO de cifras] |
| 2024 | `SS/T/24/ZZ/CO/N/0021` | 1.800.000 €/año (VE 7.200.000 €) | ProSalud (suscripciones del portal; negociado por exclusividad) | ficha + pliegos | [VERIFICADO] |
| 2025 | `SS/2025/DD/0049401` | 10.430.000 € sin IVA | La Integradora (aplicaciones) | ficha | [VERIFICADO] |
| futuro | (sin expediente) | 37.200.000 €, 60 meses — unificación | — | nota oficial del Consejo de Gobierno | [PENDIENTE: ventana de licitación estimada] |

## Qué demuestra la cadena (y el control adversarial aplicado)

1. **Fragmentación**: la "historia clínica unificada" es en la práctica una familia de
   ≥10 empresas y ≥12 expedientes; sumar "todo lo de historia clínica" sin criterio es
   doble conteo garantizado (adjudicado ≠ suma de anualidades).
2. **Reset de nomenclatura**: mismos números base pero años distintos son contratos
   distintos; el año va en el bloque 3 (y el formato varía por órgano).
3. **Primera fuente**: cada fila se carga desde ficha PLACSP, BOE o TED; los agregadores
   (LiciRadar, OpenProcurements, concursospublicos.com) solo sirven para encontrar el
   `idEvl`.
4. **El eslabón perdido**: los contratos intermedios nunca aparecen en búsqueda pública —
   solo como "el contrato anterior". Hipótesis: ahí cabe una solicitud de información
   (no automatizable; decisión de una persona) porque no hay alternativa pública —
   [PENDIENTE].
5. **Ventana futura**: extrapolar el ritmo propio del órgano (gasto autorizado →
   licitación; la propia tabla te da un intervalo) [HIPÓTESIS], a vigilar con las
   alertas/suscripciones del perfil del contratante.

## Fuentes (reales)

- Fichas PLACSP (gramática en `skills/placsp/SKILL.md` — tokens por expediente)
- BOE (`boe.es/diario_boe/txt.php?id=BOE-B-<AAAA>-<N>`)
- TED (API v3 + XML; gramática en `skills/doue-ted/SKILL.md`)
- Notas oficiales del órgano (`www3.<dominio>.org/noticias/...`)
- Informes de las cámaras/órganos de control (OCEX)

Fecha de consulta: 2026-10 (compilado; datos de empresa/expedientes/importes GENERADOS).
Todo el material de estructura es público.
