// Tasas de cambio por fecha. Flujo: moneda local -> USD -> HNL, con las tasas del día del gasto.
//
// La tasa USD -> HNL que pide Contabilidad es la de VENTA del Banco Central de Honduras (BCH).
// El BCH no ofrece un servicio abierto que la app pueda leer, así que la escribes una vez por
// fecha y queda guardada para todos los gastos de ese día. Mientras tanto la app propone la
// última tasa de venta BCH que hayas guardado (o la de mercado si no hay ninguna), marcada
// como "por verificar".

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

export const BCH_VENTA = "BCH venta";
export const BCH_URL = "https://www.bch.hn/";

// ¿La tasa del gasto ya es la de venta del BCH confirmada?
export const isBCHVenta = (e) => e.rateHNLSource === BCH_VENTA;

// Tasa USD -> HNL: primero la de venta del BCH que hayas guardado para esa fecha.
export async function rateUSDtoHNL(date) {
  const saved = await db.get("rates", date);
  if (saved && saved.hnl && saved.kind === "venta") return { rate: saved.hnl, source: BCH_VENTA, bch: true };
  // Propuesta: la tasa de venta guardada más cercana (antes de esa fecha, si hay).
  const ventas = (await db.all("rates")).filter((r) => r.kind === "venta" && r.hnl);
  if (ventas.length) {
    const before = ventas.filter((r) => r.date <= date).sort((a, b) => b.date.localeCompare(a.date));
    const near = before[0] || ventas.sort((a, b) => a.date.localeCompare(b.date))[0];
    return { rate: near.hnl, source: `BCH venta del ${near.date} (verificar la del día)`, bch: false };
  }
  const table = await usdTable(date);
  const hnl = table.rates.hnl;
  if (!hnl) throw new Error("No hay tasa USD→HNL disponible.");
  return { rate: hnl, source: `Mercado ${table.date} (no es la venta BCH: corrígela)`, bch: false };
}

export function saveBCHRate(date, hnl) {
  return db.put("rates", { date, hnl: Number(hnl), kind: "venta" });
}

// Aplica la tasa de venta BCH de una fecha a todos los gastos en moneda extranjera de ese día.
export async function applyBCHRate(date, hnl) {
  await saveBCHRate(date, hnl);
  const all = await db.all("expenses");
  let n = 0;
  for (const e of all) {
    if (e.date !== date || e.currency === "HNL" || !e.rateToUSD) continue;
    Object.assign(e, { rateHNL: Number(hnl), rateHNLSource: BCH_VENTA }, convert(e.amount, e.rateToUSD, Number(hnl)));
    await db.put("expenses", e);
    n++;
  }
  return n;
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
