DATOS GENERADOS — todo el contenido de este archivo es ficticio y existe solo
para las pruebas del parser: NIFs placeholder (`555XXXXXX`), cifras redondas
absurdas y URLs de ejemplo. Ninguna empresa, órgano o cifra es real.

## Informe de ejemplo (ficticio)

Prosa introductoria de relleno: el parser debe extraer únicamente los bloques
fenced `json` que contengan un objeto con `id`, ignorando el texto alrededor.

```json
{
  "id": "claim-ficticio-001",
  "afirmacion": "El Órgano Ficticio A adjudicó 1.000.000,00 € a la Sociedad Ficticia Uno S.L. (NIF 555XXXXXX) durante el ejercicio ficticio 2025.",
  "cifra": "1.000.000,00 €",
  "fuente": "Portal Generado de Adjudicaciones",
  "url": "https://example.com/generados/claim-001",
  "fecha_dato": "2025-06-30",
  "fecha_consulta": "2026-11-01",
  "criterio": "Todas las adjudicaciones del dataset generado con importe >= 1.000.000,00 €.",
  "filas_traidas": 10,
  "conteo_declarado": 10,
  "banderas": [],
  "dedup": false,
  "etiqueta": "VERIFICADO",
  "licencia": "Fuente: Datos Generados (fixture de prueba)"
}
```

Prosa intermedia: un segundo claim con propósito deliberadamente incompleto de
cifra, para ejercitar los campos opcionales del contrato.

```json
{
  "id": "claim-ficticio-002",
  "afirmacion": "La Sociedad Ficticia Dos S.L. (NIF 555XXXXXX) facturó 2.000.000,00 € en el primer semestre ficticio.",
  "fuente": "CSV Generado Truncado",
  "url": "https://example.com/generados/claim-002",
  "fecha_dato": "2025-12-31",
  "fecha_consulta": "2026-11-01",
  "criterio": "Suma de la columna importe del CSV generado, sin IGIC ni anualidades.",
  "filas_traidas": 500,
  "conteo_declarado": 60000,
  "banderas": ["CSV truncado"],
  "dedup": true,
  "etiqueta": "HIPÓTESIS"
}
```

Tercer claim: otra combinación de campos opcionales ausentes y etiqueta
distinta, para cubrir variaciones del contrato dentro del mismo fixture.

```json
{
  "id": "claim-ficticio-003",
  "afirmacion": "Quedan 3.000 personas ficticias en lista de espera generada.",
  "cifra": "3.000 personas",
  "fuente": "Registro Generado de Listas de Espera",
  "url": "https://example.com/generados/claim-003",
  "fecha_dato": "2025-03-31",
  "fecha_consulta": "2026-11-01",
  "criterio": "Personas del registro generado a fecha ficticia de corte.",
  "banderas": [],
  "dedup": false,
  "etiqueta": "PENDIENTE"
}
```

Y, a propósito, un último bloque `json` **sin** campo `id`: no es una
afirmación (claim) y el parser debe saltarlo sin avisar.

```json
{
  "titulo": "Anexo generado",
  "descripcion": "Bloque json deliberadamente sin id; el parser no debe tratarlo como claim."
}
```

Cierre en prosa: nada más que extraer después de este párrafo.
