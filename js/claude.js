// Lectura de recibos y traducción con Claude. La clave de API se guarda solo en el teléfono.

import Anthropic from "../vendor/anthropic-sdk-0.133.0.mjs";
import { getSetting } from "./db.js";

const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const CATEGORIES = [
  "Alimentación",
  "Transporte",
  "Hospedaje",
  "Internet y teléfono",
  "Visas y trámites",
  "Boletos aéreos",
  "Otros",
];

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    date: { type: "string", description: "Fecha de la transacción en formato YYYY-MM-DD, o cadena vacía si no aparece" },
    country: { type: "string", description: "País donde ocurrió el gasto, en español" },
    city: { type: "string", description: "Ciudad, o cadena vacía" },
    merchant: { type: "string", description: "Nombre comercial del proveedor o servicio" },
    invoice_number: { type: "string", description: "Número de factura, recibo, orden o ticket; cadena vacía si no hay" },
    amount: { type: "number", description: "Total pagado en la moneda original, incluyendo impuestos y propina" },
    currency: { type: "string", description: "Código ISO 4217 de la moneda del total (USD, CNY, NPR, EUR...)" },
    tip: { type: "number", description: "Propina incluida en el total, 0 si no hay" },
    payment_method: { type: "string", enum: ["Tarjeta", "Efectivo", "Desconocido"] },
    category: { type: "string", enum: CATEGORIES },
    description_es: { type: "string", description: "Concepto corto en español, por ejemplo 'Desayuno'" },
    description_en: { type: "string", description: "El mismo concepto en inglés, por ejemplo 'Breakfast'" },
    notes: { type: "string", description: "Dudas de lectura (texto borroso, total ambiguo), o cadena vacía" },
  },
  required: [
    "date", "country", "city", "merchant", "invoice_number", "amount", "currency",
    "tip", "payment_method", "category", "description_es", "description_en", "notes",
  ],
  additionalProperties: false,
};

const RECEIPT_PROMPT = `Lee este comprobante de un gasto de viaje (foto de recibo, factura, o captura de pantalla de Uber u otra app) y extrae los datos.

- El monto es el total final cobrado en la moneda original. Si hay varios totales, usa el que realmente se pagó.
- Deduce el país por la dirección, el idioma, la moneda o el formato del comprobante.
- La fecha va en YYYY-MM-DD. Si el comprobante usa formato día/mes o mes/día ambiguo, usa el país para decidir y anótalo en notes.
- El concepto es una descripción corta del gasto (Desayuno, Almuerzo, Cena, Uber al aeropuerto, Internet para el celular, Café).
- Si algo no se puede leer, deja el campo vacío o en 0 y explícalo en notes. No inventes datos.`;

async function client() {
  const apiKey = await getSetting("apiKey");
  if (!apiKey) throw new Error("Falta la clave de Claude. Agrégala en Ajustes.");
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

async function ask({ content, schema, effort }) {
  const c = await client();
  const response = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("Claude no pudo procesar este comprobante. Llena los datos a mano.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("La respuesta de Claude quedó incompleta. Intenta de nuevo.");
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function readReceipt(blob) {
  const data = await blobToBase64(blob);
  const source = { type: "base64", media_type: blob.type, data };
  const block = blob.type === "application/pdf" ? { type: "document", source } : { type: "image", source };
  return ask({ content: [block, { type: "text", text: RECEIPT_PROMPT }], schema: RECEIPT_SCHEMA, effort: "medium" });
}

const TRANSLATE_SCHEMA = {
  type: "object",
  properties: { english: { type: "string" } },
  required: ["english"],
  additionalProperties: false,
};

export async function translateToEnglish(spanish) {
  const result = await ask({
    content: [{
      type: "text",
      text: `Traduce al inglés este concepto de un reporte de gastos de viaje. Mantén el mismo tono corto, sin agregar nada.\n\n${spanish}`,
    }],
    schema: TRANSLATE_SCHEMA,
    effort: "low",
  });
  return result.english;
}

// Página oficial del BCH con el tipo de cambio diario de compra y venta.
export const BCH_RATE_PAGE = "https://www.bch.hn/estadisticas-y-publicaciones-economicas/tipo-de-cambio-nominal";

// Fuentes donde Claude busca la tasa: el BCH primero y, si su página no se deja leer, los diarios
// que publican cada día la tasa oficial del BCH.
const RATE_DOMAINS = ["bch.hn", "laprensa.hn", "elheraldo.hn", "latribuna.hn", "proceso.hn", "tunota.com"];

// Busca en internet la tasa de VENTA del dólar del Banco Central de Honduras para una fecha.
// Devuelve { venta, compra, publishedDate, url } o lanza un error si no la encuentra.
export async function findBCHVentaRate(date) {
  const c = await client();
  const prompt = `Busca la tasa de cambio oficial del Banco Central de Honduras (BCH) para el dólar estadounidense vigente el ${date} (YYYY-MM-DD).

- Necesito la tasa de VENTA (no la de compra ni el precio de referencia). Normalmente la venta es la compra multiplicada por 1.005.
- Si esa fecha es sábado, domingo o feriado, el BCH no publica: usa la última tasa publicada antes de esa fecha, que es la vigente ese día.
- Primero abre la página oficial del BCH, Estadísticas y Publicaciones Económicas > Tipo de Cambio Nominal: ${BCH_RATE_PAGE} (y el archivo de tipo de cambio diario que enlace).
- Si esa página no muestra la tabla, busca en bch.hn o en un diario hondureño que cite la tasa oficial del BCH para esa fecha exacta. No uses tasas de otras fechas ni de casas de cambio.

Al final responde solo con un objeto JSON en una línea, sin texto después:
{"venta": número o null, "compra": número o null, "fecha_publicada": "YYYY-MM-DD", "url": "fuente"}
Si no encuentras la tasa de esa fecha, responde {"venta": null, "compra": null, "fecha_publicada": "", "url": ""}.`;

  const messages = [{ role: "user", content: prompt }];
  let response;
  for (let i = 0; i < 4; i++) {
    response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "low" },
      tools: [
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4, allowed_domains: RATE_DOMAINS },
        { type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_domains: RATE_DOMAINS },
      ],
      messages,
    });
    // Búsquedas largas pausan el turno; se reenvía tal cual y el servidor continúa.
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  if (response.stop_reason === "refusal") throw new Error("Claude no pudo buscar la tasa.");
  if (response.stop_reason !== "end_turn") throw new Error("La búsqueda de la tasa quedó incompleta.");

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\{[^{}]*"venta"[^{}]*\}/g);
  if (!match) throw new Error("No se encontró la tasa de venta del BCH para esa fecha.");
  const r = JSON.parse(match[match.length - 1]);
  const venta = Number(r.venta);
  const compra = Number(r.compra);
  // Controles: un valor razonable y, si vino la compra, que la venta sea compra × 1.005.
  if (!(venta > 15 && venta < 60)) throw new Error("No se encontró la tasa de venta del BCH para esa fecha.");
  if (compra && Math.abs(venta / compra - 1.005) > 0.002) throw new Error("La tasa encontrada no parece la de venta del BCH.");
  return { venta, compra: compra || null, publishedDate: r.fecha_publicada || "", url: r.url || "" };
}
