// Vista de la liquidación con el mismo diseño del formato aprobado, y el anexo de comprobantes.
// Ambas se pueden guardar como PDF en vertical u horizontal.

/* global html2canvas, jspdf */

import { rowDate, headerDate, descriptionCell, tripLine } from "./xlsx.js";

// Anchos de columna del formato original (A..O), en caracteres de Excel.
const COLS = [21.78, 3, 32.89, 1.33, 2.89, 20.66, 2.11, 24.44, 2.89, 0.11, 1.44, 25.44, 14.66, 16.11, 24.66];
const TOTAL_W = COLS.reduce((a, b) => a + b, 0);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const money = (n) =>
  Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function lempiras(n) {
  const neg = Number(n) < 0;
  return `<span class="acct"><span>${neg ? "-L" : "L"}</span><span>${money(Math.abs(n))}</span></span>`;
}

// Construye una tabla de 15 columnas a partir de filas [alto en pt, celdas].
// Cada celda: { c: columna inicial (1 = A), span, rows, html, cls }.
function grid(rows) {
  const taken = new Set();
  let out = "";
  rows.forEach(([height, cells], ri) => {
    out += `<tr style="height:calc(${height}pt * var(--k))">`;
    const byCol = new Map(cells.map((cell) => [cell.c, cell]));
    for (let c = 1; c <= 15; c++) {
      if (taken.has(`${ri}:${c}`)) continue;
      const cell = byCol.get(c);
      if (!cell) {
        out += "<td></td>";
        continue;
      }
      const span = cell.span || 1;
      const rs = cell.rows || 1;
      for (let r = 0; r < rs; r++) for (let k = 0; k < span; k++) taken.add(`${ri + r}:${c + k}`);
      out += `<td${span > 1 ? ` colspan="${span}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""} class="${cell.cls || ""}">${cell.html ?? ""}</td>`;
      c += span - 1;
    }
    out += "</tr>";
  });
  return out;
}

export function liquidationHTML(trip, expenses, logoURL) {
  const total = Math.round(expenses.reduce((s, e) => s + (Number(e.hnl) || 0), 0) * 100) / 100;
  const transfer = Number(trip.budgetHNL) || 0;
  const deposit = Math.round((transfer - total) * 100) / 100;
  const dataRows = Math.max(expenses.length + 1, 9);

  const rows = [
    [72.6, [{ c: 1, span: 15, html: logoURL ? `<img class="logo" src="${logoURL}" alt="">` : "" }]],
    [21, [{ c: 1, span: 14, html: "REPORTE DE LIQUIDACIÓN DE GASTOS", cls: "title" }]],
    [21, [{ c: 1, span: 14, html: esc(tripLine(trip)), cls: "trip" }]],
    [46.65, [
      { c: 1, span: 3, html: `Fecha: ${headerDate(trip.closedAt ? new Date(trip.closedAt) : new Date())}`, cls: "box top left" },
      { c: 6, span: 2, html: `Número de Solicitud:<br>${esc(trip.requestNumber)}`, cls: "box top center" },
      { c: 8, html: `Número de Referencia:<br>${esc(trip.referenceNumber)}`, cls: "box top center small" },
      { c: 12, span: 4, html: "Fecha y Firma Gerente de Área:", cls: "box top center small" },
    ]],
    [15.6, []],
    [15.75, [
      { c: 1, span: 3, html: "Se adjunta la siguiente documentación de soporte:", cls: "small nowrap" },
      { c: 12, span: 4, rows: 3, html: "Firma y Fecha de Recibido en Contabilidad:", cls: "box top center small" },
    ]],
    [15.75, []],
    [15.75, []],
    [15.6, [
      { c: 3, html: "Reporte de Alimentación", cls: "right small" },
      { c: 5, html: trip.foodReport ? "X" : "", cls: "check" },
    ]],
    [3.75, [{ c: 12, span: 4, rows: 5, html: "Firma y Fecha de Autorizado por Dirección Nacional:", cls: "box top center small" }]],
    [15.6, []],
    [4.35, []],
    [15.6, [
      { c: 3, html: "Depósito", cls: "right small" },
      { c: 5, html: trip.deposit ? "X" : "", cls: "check" },
    ]],
    [15.6, []],
    [21.6, [{ c: 1, span: 3, html: "DESGLOSE DE GASTOS", cls: "section" }]],
    [29.4, [
      { c: 1, span: 2, html: "FECHA", cls: "th" },
      { c: 3, span: 3, html: "PROVEEDOR", cls: "th" },
      { c: 6, span: 2, html: "# DE FACTURA", cls: "th" },
      { c: 8, span: 5, html: "DESCRIPCIÓN DEL GASTO", cls: "th" },
      { c: 13, html: "VALOR HNL", cls: "th" },
      { c: 14, html: "CÓDIGO DE PROGRAMA", cls: "th" },
      { c: 15, html: "CÓDIGO DE CUENTA", cls: "th" },
    ]],
  ];
  for (let i = 0; i < dataRows; i++) {
    const e = expenses[i];
    rows.push([40.2, [
      { c: 1, span: 2, html: e ? rowDate(e.date) : "", cls: "td" },
      { c: 3, span: 3, html: e ? esc((e.merchant || "").toUpperCase()) : "", cls: "td" },
      { c: 6, span: 2, html: e ? esc(e.invoice) : "", cls: "td" },
      { c: 8, span: 5, html: e ? esc(descriptionCell(e)) : "", cls: "td desc" },
      { c: 13, html: e ? lempiras(e.hnl) : "", cls: "td" },
      { c: 14, html: e ? esc(e.programCode) : "", cls: "td" },
      { c: 15, html: e ? esc(e.accountCode) : "", cls: "td" },
    ]]);
  }
  rows.push(
    [16.2, [
      { c: 12, html: "GRAN TOTAL", cls: "box center bold" },
      { c: 13, html: lempiras(total), cls: "box bold" },
    ]],
    [16.2, []],
    [16.2, [
      { c: 1, span: 2, rows: 2, html: "Journal Entry #", cls: "box center bold small" },
      { c: 3, rows: 2, html: "", cls: "box" },
      { c: 6, span: 5, html: `Nombre del Empleado: ${esc((trip.employeeName || "").toUpperCase())}`, cls: "box left bold small" },
      { c: 12, html: "Valor Transferencia", cls: "box center bold small" },
      { c: 13, html: lempiras(transfer), cls: "box bold small" },
      { c: 15, html: "", cls: "box" },
    ]],
    [16.2, [
      { c: 6, span: 5, html: "Firma:", cls: "box left bold small" },
      { c: 12, html: "Valor a Depositar", cls: "box center bold small" },
      { c: 13, html: lempiras(deposit), cls: "box bold small" },
      { c: 15, html: "Cash Reconciliation #", cls: "box center bold small" },
    ]],
  );

  const colgroup = COLS.map((w) => `<col style="width:${((w / TOTAL_W) * 100).toFixed(3)}%">`).join("");
  return `<table class="liq"><colgroup>${colgroup}</colgroup>${grid(rows)}</table>`;
}

export function annexHTML(trip, expenses, imageURLs) {
  const cards = expenses
    .map((e, i) => {
      const img = imageURLs[e.id];
      const media = img
        ? img.pdf
          ? `<div class="noimg">Comprobante en PDF<br>${esc(e.fileName || "")}</div>`
          : `<img src="${img.url}" alt="">`
        : `<div class="noimg">${e.noReceipt ? "Gasto sin comprobante" : "Sin imagen"}</div>`;
      return `
      <section class="annex-card">
        <div class="annex-img">${media}</div>
        <div class="annex-data">
          <h3>${i + 1}. ${esc(e.merchant || "")}</h3>
          <dl>
            <dt>Fecha</dt><dd>${rowDate(e.date)}</dd>
            <dt>Lugar</dt><dd>${esc([e.city, e.country].filter(Boolean).join(", "))}</dd>
            <dt>Factura</dt><dd>${esc(e.invoice || "—")}</dd>
            <dt>Concepto</dt><dd>${esc(e.descEs || "")}<br><em>${esc(e.descEn || "")}</em></dd>
            <dt>Monto original</dt><dd><strong>${money(e.amount)} ${esc(e.currency)}</strong></dd>
            <dt>Tasa a USD</dt><dd>${Number(e.rateToUSD).toFixed(6)} · ${money(e.usd)} USD</dd>
            <dt>Tasa USD→HNL</dt><dd>${Number(e.rateHNL).toFixed(4)} (${esc(e.rateHNLSource || "")})</dd>
            <dt>Monto en lempiras</dt><dd><strong>L ${money(e.hnl)}</strong></dd>
          </dl>
          ${e.noReceipt ? `<p class="note">Nota: ${esc(e.noReceiptNote || "")}</p>` : ""}
        </div>
      </section>`;
    })
    .join("");
  return `<div class="annex">
    <header><h2>ANEXO DE COMPROBANTES</h2><p>${esc(tripLine(trip))}</p></header>
    ${cards}
  </div>`;
}

// Genera un PDF a partir de un elemento, en la orientación elegida, tamaño carta.
export async function elementToPDF(el, orientation, { paginate = false } = {}) {
  const { jsPDF } = jspdf;
  const pdf = new jsPDF({ orientation, unit: "in", format: "letter" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 0.31;
  const usableW = pageW - margin * 2;
  const usableH = pageH - margin * 2;

  const blocks = paginate ? Array.from(el.children) : [el];
  let y = margin;
  let first = true;
  for (const block of blocks) {
    const canvas = await html2canvas(block, { scale: 3, backgroundColor: "#ffffff", useCORS: true });
    const h = (canvas.height / canvas.width) * usableW;
    if (!paginate && h > usableH && usableH / h >= 0.55) {
      // Cabe en una página reduciéndola un poco: se centra a lo ancho.
      const w = (canvas.width / canvas.height) * usableH;
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", margin + (usableW - w) / 2, margin, w, usableH);
      first = false;
      continue;
    }
    if (!paginate) {
      // La liquidación se ajusta a lo ancho; si es más alta que la página, continúa en otra.
      const pxPerPage = Math.floor((usableH / usableW) * canvas.width);
      for (let top = 0; top < canvas.height; top += pxPerPage) {
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = Math.min(pxPerPage, canvas.height - top);
        slice.getContext("2d").drawImage(canvas, 0, top, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
        if (!first) pdf.addPage();
        first = false;
        pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, usableW, (slice.height / canvas.width) * usableW);
      }
      continue;
    }
    if (!first && y + h > pageH - margin) {
      pdf.addPage();
      y = margin;
    }
    const drawH = Math.min(h, usableH);
    const drawW = drawH < h ? (canvas.width / canvas.height) * drawH : usableW;
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", margin, y, drawW, drawH);
    y += drawH + 0.15;
    first = false;
  }
  return pdf.output("blob");
}
