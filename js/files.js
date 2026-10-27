// Fotos de comprobantes, nombres de archivo y envío a la app Archivos del iPhone.

/* global JSZip */

import { rowDate, descriptionCell } from "./xlsx.js";

// Reduce la foto a un tamaño legible pero liviano (máx. 2000 px por lado, JPEG).
export async function prepareImage(file) {
  if (file.type === "application/pdf") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const max = 2000;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), "image/jpeg", 0.85));
}

export function slug(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "gasto";
}

export function tripFolderName(trip) {
  return `AL1 - ${trip.name}`.replace(/[\\/:*?"<>|]/g, "-");
}

// 2026-11-12_001_Wendys.jpg
export function receiptFileName(e, seq, mime) {
  const ext = mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg";
  return `${e.date}_${String(seq).padStart(3, "0")}_${slug(e.merchant)}.${ext}`;
}

// Abre la hoja de compartir del iPhone ("Guardar en Archivos") o descarga el archivo.
export async function shareOrDownload(blob, fileName) {
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return "shared";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function detailCSV(expenses) {
  const head = [
    "No.", "Fecha", "País", "Ciudad", "Proveedor", "# Factura", "Concepto (ES)", "Concept (EN)", "Descripción",
    "Categoría", "Método de pago", "Monto original", "Moneda", "Tasa a USD", "Monto USD",
    "Tasa USD a HNL", "Fuente tasa HNL", "Valor HNL", "Código de programa", "Código de cuenta", "Archivo",
  ];
  const rows = expenses.map((e, i) => [
    i + 1, rowDate(e.date), e.country, e.city, e.merchant, e.invoice, e.descEs, e.descEn, descriptionCell(e),
    e.category, e.paymentMethod, e.amount, e.currency, e.rateToUSD, e.usd,
    e.rateHNL, e.rateHNLSource, e.hnl, e.programCode, e.accountCode, e.fileName || "",
  ]);
  return "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

// Arma un .zip con la carpeta del viaje: comprobantes, liquidación y detalle.
export async function tripZip(trip, expenses, blobsById, extras = {}) {
  const zip = new JSZip();
  const root = zip.folder(tripFolderName(trip));
  const receipts = root.folder("Comprobantes");
  expenses.forEach((e, i) => {
    const blob = blobsById[e.id];
    if (blob) receipts.file(receiptFileName(e, i + 1, blob.type), blob);
  });
  root.file("Detalle de gastos.csv", detailCSV(expenses));
  for (const [name, blob] of Object.entries(extras)) if (blob) root.file(name, blob);
  return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
}
