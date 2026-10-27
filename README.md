# AL1 · Gastos de viaje

App web para el iPhone que registra los gastos de un viaje y genera la liquidación en lempiras con el formato aprobado.

## Qué hace

- **Viajes:** nombre, objetivo, fechas, presupuesto (Valor Transferencia), número de solicitud y de referencia.
- **Captura:** foto del recibo, captura de pantalla (Uber, facturas digitales) o PDF. Claude lee país, ciudad, comercio, número de factura, fecha, monto, moneda, propina y concepto en español e inglés.
- **Revisión:** todos los datos quedan editables antes de tocar **Registrar**, y después también.
- **Conversión:** moneda local → USD → HNL con las tasas del día de cada gasto. La tasa USD→HNL se puede marcar como la oficial del BCH y se reutiliza para esa fecha.
- **Liquidación:** llena una copia del formato original (.xlsx) sin cambiar su diseño, y genera un PDF en vertical u horizontal.
- **Anexo de comprobantes:** cada imagen con su monto original, las tasas usadas y el monto en lempiras, en PDF.
- **Carpeta del viaje:** un .zip con los comprobantes nombrados por fecha (`2026-11-12_001_Wendys.jpg`), la liquidación y el detalle en CSV, para guardar en Archivos o iCloud.

## Privacidad

Los viajes, gastos, fotos, el formato de liquidación y la clave de Claude se guardan solo en el teléfono (IndexedDB). Este repositorio contiene únicamente el código. Las fotos se envían a Claude para leerlas, y las fechas y monedas al servicio de tasas.

## Instalar en el iPhone

1. En GitHub, ve a **Settings → Pages**, elige **Deploy from a branch**, rama `main`, carpeta `/ (root)`, y guarda.
2. Abre en Safari la dirección que muestra GitHub Pages (por ejemplo `https://storycrafters26.github.io/AL1/`).
3. Toca **Compartir → Agregar a pantalla de inicio**.
4. Abre AL1 desde el ícono, ve a **Ajustes**, pega tu clave de Claude y carga el formato de liquidación (.xlsx).

## Estructura

| Archivo | Para qué |
| --- | --- |
| `index.html`, `css/` | Interfaz |
| `js/app.js` | Pantallas: viajes, gasto, liquidación, anexo, ajustes |
| `js/claude.js` | Lectura de recibos y traducción con Claude |
| `js/rates.js` | Tasas por fecha y conversión |
| `js/xlsx.js` | Llenado del formato original de Excel |
| `js/print.js` | Vista de la liquidación y del anexo, y PDF |
| `js/files.js` | Fotos, nombres de archivo y carpeta del viaje |
| `js/db.js` | Almacenamiento en el teléfono |
| `sw.js` | Funciona sin internet |
| `vendor/` | Librerías incluidas (SDK de Anthropic, JSZip, html2canvas, jsPDF) |

No hay paso de compilación: son archivos estáticos.
