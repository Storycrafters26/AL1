// Tasas de cambio por fecha. Flujo: moneda local -> USD -> HNL, con las tasas del día del gasto.
//
// La tasa USD -> HNL oficial es la del Banco Central de Honduras (BCH). La app propone la tasa
// de mercado del día como punto de partida; cuando la corriges con la del BCH, queda guardada
// para esa fecha y se reutiliza en todos los gastos de ese día.

import { db } from "./db.js";

const SOURCES = [
  (date) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`,
  (date) => `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`,
];

const memo = new Map();

// Devuelve cuántas unidades de cada moneda vale 1 USD en esa fecha.
async function usdTable(date) {
  if (memo.has(date)) return memo.get(date);
  const today = new Date().toISOString().slice(0, 10);
  const day = date > today ? today : date;
  let lastError;
  for (const url of [...SOURCES.map((s) => s(day)), ...SOURCES.map((s) => s("latest"))]) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const table = { date: json.date, rates: json.usd };
      memo.set(date, table);
      return table;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`No se pudo obtener la tasa del ${date} (${lastError?.message || "sin conexión"}).`);
}

// Tasa para pasar 1 unidad de `currency` a USD.
export async function rateToUSD(currency, date) {
  const cur = (currency || "").toUpperCase();
  if (cur === "USD") return { rate: 1, source: "USD" };
  if (cur === "HNL") {
    const { rate } = await rateUSDtoHNL(date);
    return { rate: 1 / rate, source: "Inverso de la tasa USD→HNL" };
  }
  const table = await usdTable(date);
  const perUsd = table.rates[cur.toLowerCase()];
  if (!perUsd) throw new Error(`No hay tasa para ${cur}.`);
  return { rate: 1 / perUsd, source: `Mercado ${table.date}` };
}

// Tasa USD -> HNL: primero la del BCH que hayas guardado para esa fecha.
export async function rateUSDtoHNL(date) {
  const saved = await db.get("rates", date);
  if (saved && saved.hnl) return { rate: saved.hnl, source: "BCH", bch: true };
  const table = await usdTable(date);
  const hnl = table.rates.hnl;
  if (!hnl) throw new Error("No hay tasa USD→HNL disponible.");
  return { rate: hnl, source: `Mercado ${table.date} (verificar BCH)`, bch: false };
}

export function saveBCHRate(date, hnl) {
  return db.put("rates", { date, hnl: Number(hnl) });
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Aplica el flujo de conversión a un gasto. Guarda las tasas usadas para poder auditarlas.
export function convert(amount, rateLocalToUSD, rateHNL) {
  const usd = round2(amount * rateLocalToUSD);
  const hnl = round2(usd * rateHNL);
  return { usd, hnl };
}
