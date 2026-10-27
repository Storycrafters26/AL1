// Llena una copia del formato de liquidación original (.xlsx) sin tocar su diseño:
// logo, celdas combinadas, bordes y fuentes quedan tal cual. Solo se escriben valores,
// y si hay más gastos que filas disponibles se insertan filas con el mismo estilo.

/* global JSZip */

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const colToNum = (col) => col.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const numToCol = (n) => {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
const splitRef = (ref) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { col: m[1], row: Number(m[2]) };
};

const parse = (text) => new DOMParser().parseFromString(text, "application/xml");
const serialize = (doc) => new XMLSerializer().serializeToString(doc);
const kids = (el, name) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.localName === name);

async function locateSheet(zip) {
  const wb = parse(await zip.file("xl/workbook.xml").async("string"));
  const sheet = wb.getElementsByTagNameNS(NS, "sheet")[0];
  const rid = sheet.getAttributeNS(REL_NS, "id") || sheet.getAttribute("r:id");
  const rels = parse(await zip.file("xl/_rels/workbook.xml.rels").async("string"));
  const rel = Array.from(rels.getElementsByTagName("Relationship")).find((r) => r.getAttribute("Id") === rid);
  const target = rel.getAttribute("Target").replace(/^\/?xl\//, "");
  return "xl/" + target;
}

async function sharedStrings(zip) {
  const f = zip.file("xl/sharedStrings.xml");
  if (!f) return [];
  const doc = parse(await f.async("string"));
  return Array.from(doc.getElementsByTagNameNS(NS, "si")).map((si) =>
    Array.from(si.getElementsByTagNameNS(NS, "t")).map((t) => t.textContent).join("")
  );
}

class Sheet {
  constructor(doc, strings) {
    this.doc = doc;
    this.strings = strings;
    this.sheetData = doc.getElementsByTagNameNS(NS, "sheetData")[0];
  }

  rows() {
    return kids(this.sheetData, "row");
  }

  row(r) {
    return this.rows().find((el) => Number(el.getAttribute("r")) === r);
  }

  ensureRow(r) {
    let row = this.row(r);
    if (row) return row;
    row = this.doc.createElementNS(NS, "row");
    row.setAttribute("r", r);
    const next = this.rows().find((el) => Number(el.getAttribute("r")) > r);
    this.sheetData.insertBefore(row, next || null);
    return row;
  }

  cell(ref) {
    const { col, row } = splitRef(ref);
    const rowEl = this.ensureRow(row);
    const cells = kids(rowEl, "c");
    let c = cells.find((el) => el.getAttribute("r") === ref);
    if (c) return c;
    c = this.doc.createElementNS(NS, "c");
    c.setAttribute("r", ref);
    const next = cells.find((el) => colToNum(splitRef(el.getAttribute("r")).col) > colToNum(col));
    rowEl.insertBefore(c, next || null);
    return c;
  }

  text(cellEl) {
    const t = cellEl.getAttribute("t");
    if (t === "s") {
      const v = kids(cellEl, "v")[0];
      return v ? this.strings[Number(v.textContent)] || "" : "";
    }
    if (t === "inlineStr") return cellEl.textContent;
    const v = kids(cellEl, "v")[0];
    return v ? v.textContent : "";
  }

  find(predicate) {
    for (const row of this.rows()) {
      for (const c of kids(row, "c")) {
        const text = this.text(c).trim();
        if (text && predicate(text)) return c.getAttribute("r");
      }
    }
    return null;
  }

  clear(ref) {
    const c = this.cell(ref);
    while (c.firstChild) c.removeChild(c.firstChild);
    c.removeAttribute("t");
    return c;
  }

  setText(ref, value) {
    const c = this.clear(ref);
    if (value === "" || value == null) return;
    c.setAttribute("t", "inlineStr");
    const is = this.doc.createElementNS(NS, "is");
    const t = this.doc.createElementNS(NS, "t");
    t.setAttribute("xml:space", "preserve");
    t.textContent = String(value);
    is.appendChild(t);
    c.appendChild(is);
  }

  setNumber(ref, value) {
    const c = this.clear(ref);
    if (value === "" || value == null || Number.isNaN(Number(value))) return;
    const v = this.doc.createElementNS(NS, "v");
    v.textContent = String(value);
    c.appendChild(v);
  }

  setFormula(ref, formula, cached) {
    const c = this.clear(ref);
    const f = this.doc.createElementNS(NS, "f");
    f.textContent = formula;
    c.appendChild(f);
    const v = this.doc.createElementNS(NS, "v");
    v.textContent = String(cached);
    c.appendChild(v);
  }

  formula(ref) {
    const f = kids(this.cell(ref), "f")[0];
    return f ? f.textContent : null;
  }

  merges() {
    return Array.from(this.doc.getElementsByTagNameNS(NS, "mergeCell"));
  }

  // Inserta `count` filas después de la fila `after`, copiando su estilo y sus celdas combinadas.
  insertRowsAfter(after, count) {
    for (const row of this.rows().reverse()) {
      const r = Number(row.getAttribute("r"));
      if (r <= after) continue;
      row.setAttribute("r", r + count);
      for (const c of kids(row, "c")) {
        const { col } = splitRef(c.getAttribute("r"));
        c.setAttribute("r", col + (r + count));
      }
    }
    for (const m of this.merges()) m.setAttribute("ref", shiftRange(m.getAttribute("ref"), after, count));
    for (const f of this.doc.getElementsByTagNameNS(NS, "f")) f.textContent = shiftFormula(f.textContent, after, count);

    const template = this.row(after);
    const rowMerges = this.merges()
      .map((m) => m.getAttribute("ref"))
      .filter((ref) => {
        const [a, b] = ref.split(":");
        return b && splitRef(a).row === after && splitRef(b).row === after;
      });
    const mergeParent = this.doc.getElementsByTagNameNS(NS, "mergeCells")[0];
    let anchor = template;
    for (let i = 1; i <= count; i++) {
      const r = after + i;
      const clone = template.cloneNode(true);
      clone.setAttribute("r", r);
      for (const c of kids(clone, "c")) {
        const { col } = splitRef(c.getAttribute("r"));
        c.setAttribute("r", col + r);
        while (c.firstChild) c.removeChild(c.firstChild);
        c.removeAttribute("t");
      }
      this.sheetData.insertBefore(clone, anchor.nextSibling);
      anchor = clone;
      for (const ref of rowMerges) {
        const [a, b] = ref.split(":");
        const m = this.doc.createElementNS(NS, "mergeCell");
        m.setAttribute("ref", `${splitRef(a).col}${r}:${splitRef(b).col}${r}`);
        mergeParent.appendChild(m);
      }
    }
    if (mergeParent) mergeParent.setAttribute("count", this.merges().length);

    const dim = this.doc.getElementsByTagNameNS(NS, "dimension")[0];
    if (dim) dim.setAttribute("ref", shiftRange(dim.getAttribute("ref"), after, count));
  }
}

function shiftRef(ref, after, count) {
  const { col, row } = splitRef(ref);
  return row > after ? col + (row + count) : ref;
}

function shiftRange(range, after, count) {
  return range.split(":").map((r) => shiftRef(r, after, count)).join(":");
}

// Corre las referencias de una fórmula. Un rango que termina en la última fila de datos
// se amplía para incluir las filas nuevas (por ejemplo SUM(M20:M28) -> SUM(M20:M31)).
function shiftFormula(formula, after, count) {
  return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)(?::(\$?)([A-Z]+)(\$?)(\d+))?/g, (m, d1, c1, d2, r1, d3, c2, d4, r2) => {
    const a = Number(r1);
    if (!c2) return `${d1}${c1}${d2}${a > after ? a + count : a}`;
    const b = Number(r2);
    const na = a > after ? a + count : a;
    const nb = b >= after ? b + count : b;
    return `${d1}${c1}${d2}${na}:${d3}${c2}${d4}${nb}`;
  });
}

const pad = (n) => String(n).padStart(2, "0");
// Fechas de las filas como en el formato aprobado: MM/DD/AAAA.
export function rowDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}
// Fecha del encabezado como en el formato aprobado: DD/MM/AA.
export function headerDate(date = new Date()) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).slice(2)}`;
}

export function descriptionCell(e) {
  const es = (e.descEs || "").trim().toUpperCase();
  const en = (e.descEn || "").trim().toUpperCase();
  return es && en ? `${es} / ${en}` : es || en;
}

export function tripLine(trip) {
  const range = `DEL ${rowDate(trip.startDate)} AL ${rowDate(trip.endDate || trip.startDate)}`;
  return `${(trip.name || "").toUpperCase()} · ${range}`;
}

// Estilos del libro. Solo se agregan estilos nuevos al final; los existentes no se tocan.
class Styles {
  static async load(zip) {
    const st = new Styles();
    st.zip = zip;
    st.doc = parse(await zip.file("xl/styles.xml").async("string"));
    st.xfs = st.doc.getElementsByTagNameNS(NS, "cellXfs")[0];
    st.memo = new Map();
    return st;
  }

  xf(index) {
    return kids(this.xfs, "xf")[Number(index)];
  }

  add(xf) {
    this.xfs.appendChild(xf);
    const n = kids(this.xfs, "xf").length;
    this.xfs.setAttribute("count", n);
    return n - 1;
  }

  // Igual al estilo del título pero con letra de 12 en negrita (línea del viaje).
  smallerBold(index) {
    const fonts = kids(this.doc.getElementsByTagNameNS(NS, "fonts")[0], "font");
    const fontId = fonts.findIndex((f) => {
      const sz = kids(f, "sz")[0];
      return kids(f, "b").length && sz && sz.getAttribute("val") === "12";
    });
    const xf = this.xf(index).cloneNode(true);
    if (fontId >= 0) {
      xf.setAttribute("fontId", fontId);
      xf.setAttribute("applyFont", "1");
    }
    return this.add(xf);
  }

  // El mismo estilo con otro formato de número (para mostrar "L" en los montos).
  withNumFmt(index, numFmtId) {
    const key = `${index}:${numFmtId}`;
    if (!this.memo.has(key)) {
      const xf = this.xf(index).cloneNode(true);
      xf.setAttribute("numFmtId", numFmtId);
      xf.setAttribute("applyNumberFormat", "1");
      this.memo.set(key, this.add(xf));
    }
    return this.memo.get(key);
  }

  save() {
    this.zip.file("xl/styles.xml", serialize(this.doc));
  }
}

const rightOf = (ref, n = 1) => {
  const { col, row } = splitRef(ref);
  return numToCol(colToNum(col) + n) + row;
};

/**
 * @param {Blob} templateBlob  el .xlsx original
 * @param {object} trip
 * @param {object[]} expenses  ya ordenados por fecha
 * @param {{orientation: "portrait"|"landscape"}} opts
 */
export async function fillTemplate(templateBlob, trip, expenses, opts = {}) {
  const zip = await JSZip.loadAsync(templateBlob);
  const sheetPath = await locateSheet(zip);
  const strings = await sharedStrings(zip);
  const doc = parse(await zip.file(sheetPath).async("string"));
  const sh = new Sheet(doc, strings);
  const styles = await Styles.load(zip);

  const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const fechaHdr = sh.find((t) => norm(t) === "FECHA");
  if (!fechaHdr) throw new Error("No encontré la columna FECHA en el formato.");
  const headerRow = splitRef(fechaHdr).row;
  const headerCells = kids(sh.row(headerRow), "c");
  const colOf = (label) => {
    const c = headerCells.find((el) => norm(sh.text(el).trim()).startsWith(label));
    return c ? splitRef(c.getAttribute("r")).col : null;
  };
  const cols = {
    date: splitRef(fechaHdr).col,
    vendor: colOf("PROVEEDOR"),
    invoice: colOf("# DE FACTURA"),
    desc: colOf("DESCRIPCION"),
    hnl: colOf("VALOR HNL"),
    program: colOf("CODIGO DE PROGRAMA"),
    account: colOf("CODIGO DE CUENTA"),
  };
  const totalLabel = sh.find((t) => norm(t) === "GRAN TOTAL");
  if (!totalLabel) throw new Error("No encontré GRAN TOTAL en el formato.");
  const firstData = headerRow + 1;
  let lastData = splitRef(totalLabel).row - 1;
  const capacity = lastData - firstData + 1;

  // Limpia las filas de ejemplo del formato.
  for (let r = firstData; r <= lastData; r++) {
    for (const c of Object.values(cols)) if (c) sh.clear(c + r);
  }

  if (expenses.length > capacity) {
    const extra = expenses.length - capacity;
    sh.insertRowsAfter(lastData, extra);
    lastData += extra;
  }

  // Los montos usan el mismo formato con "L" del gran total, y la columna de código de
  // programa toma un solo estilo (el formato original mezcla negrita y normal).
  const totalStyle = sh.cell(rightOf(sh.find((t) => norm(t) === "GRAN TOTAL"))).getAttribute("s");
  const moneyFmt = totalStyle != null ? styles.xf(totalStyle).getAttribute("numFmtId") : null;
  const programStyle = cols.program ? sh.cell(cols.program + lastData).getAttribute("s") : null;
  for (let r = firstData; r <= lastData; r++) {
    if (moneyFmt && cols.hnl) {
      const s = sh.cell(cols.hnl + r).getAttribute("s");
      if (s != null) sh.cell(cols.hnl + r).setAttribute("s", styles.withNumFmt(s, moneyFmt));
    }
    if (programStyle != null) sh.cell(cols.program + r).setAttribute("s", programStyle);
  }

  let total = 0;
  expenses.forEach((e, i) => {
    const r = firstData + i;
    sh.setText(cols.date + r, rowDate(e.date));
    if (cols.vendor) sh.setText(cols.vendor + r, (e.merchant || "").toUpperCase());
    if (cols.invoice) sh.setText(cols.invoice + r, e.invoice || "");
    if (cols.desc) sh.setText(cols.desc + r, descriptionCell(e));
    if (cols.hnl) sh.setNumber(cols.hnl + r, e.hnl);
    if (cols.program) sh.setText(cols.program + r, e.programCode || "");
    if (cols.account) sh.setText(cols.account + r, e.accountCode || "");
    total += Number(e.hnl) || 0;
  });
  total = Math.round(total * 100) / 100;

  // Gran total, transferencia y valor a depositar.
  const totalRef = sh.find((t) => norm(t) === "GRAN TOTAL");
  const totalCell = rightOf(totalRef);
  sh.setFormula(totalCell, sh.formula(totalCell) || `SUM(${cols.hnl}${firstData}:${cols.hnl}${lastData})`, total);
  const transferLabel = sh.find((t) => norm(t).startsWith("VALOR TRANSFERENCIA"));
  const transfer = Number(trip.budgetHNL) || 0;
  if (transferLabel) sh.setNumber(rightOf(transferLabel), transfer);
  const depositLabel = sh.find((t) => norm(t).startsWith("VALOR A DEPOSITAR"));
  if (depositLabel) {
    const ref = rightOf(depositLabel);
    const f = sh.formula(ref) || `${rightOf(transferLabel)}-${totalCell}`;
    sh.setFormula(ref, f, Math.round((transfer - total) * 100) / 100);
  }

  // Encabezado. El año fiscal (FY) se reemplaza por el período del viaje, en la fila
  // libre debajo del título (la celda FY queda tapada por el logo en el formato).
  const fy = sh.find((t) => /^FY\s*\d+/i.test(t));
  if (fy) sh.setText(fy, "");
  const title = sh.find((t) => norm(t).startsWith("REPORTE DE LIQUIDACION"));
  if (title) {
    const r = splitRef(title).row + 1;
    const titleMerge = sh.merges().map((m) => m.getAttribute("ref")).find((ref) => ref.startsWith(title + ":"));
    const lastCol = titleMerge ? splitRef(titleMerge.split(":")[1]).col : "N";
    const ref = "A" + r;
    sh.setText(ref, tripLine(trip));
    const titleStyle = sh.cell(title).getAttribute("s");
    if (titleStyle != null) sh.cell(ref).setAttribute("s", styles.smallerBold(titleStyle));
    if (!sh.merges().some((m) => m.getAttribute("ref").startsWith(ref + ":"))) {
      const parent = doc.getElementsByTagNameNS(NS, "mergeCells")[0];
      const m = doc.createElementNS(NS, "mergeCell");
      m.setAttribute("ref", `${ref}:${lastCol}${r}`);
      parent.appendChild(m);
      parent.setAttribute("count", sh.merges().length);
    }
  }
  const fecha = sh.find((t) => norm(t).startsWith("FECHA:"));
  if (fecha) sh.setText(fecha, `Fecha: ${headerDate(trip.closedAt ? new Date(trip.closedAt) : new Date())}`);
  const sol = sh.find((t) => norm(t).startsWith("NUMERO DE SOLICITUD"));
  if (sol) sh.setText(sol, `Número de Solicitud: ${trip.requestNumber || ""}`);
  const refNo = sh.find((t) => norm(t).startsWith("NUMERO DE REFERENCIA"));
  if (refNo) sh.setText(refNo, `Número de Referencia: ${trip.referenceNumber || ""}`);
  const emp = sh.find((t) => norm(t).startsWith("NOMBRE DEL EMPLEADO"));
  if (emp) sh.setText(emp, `Nombre del Empleado: ${(trip.employeeName || "").toUpperCase()}`);
  const food = sh.find((t) => norm(t).startsWith("REPORTE DE ALIMENTACION"));
  if (food) sh.setText(rightOf(food, 2), trip.foodReport ? "X" : "");
  const dep = sh.find((t) => norm(t) === "DEPOSITO");
  if (dep) sh.setText(rightOf(dep, 2), trip.deposit ? "X" : "");

  // Impresión: una página de ancho, vertical u horizontal.
  const ps = doc.getElementsByTagNameNS(NS, "pageSetup")[0];
  if (ps) {
    ps.setAttribute("orientation", opts.orientation === "portrait" ? "portrait" : "landscape");
    ps.removeAttribute("scale");
    ps.setAttribute("fitToWidth", "1");
    // Hasta 20 gastos caben en una sola página; con más, sigue en la siguiente.
    ps.setAttribute("fitToHeight", expenses.length <= 20 ? "1" : "0");
  }

  zip.file(sheetPath, serialize(doc));
  styles.save();

  // Que Excel/Numbers recalculen al abrir; la cadena de cálculo vieja ya no aplica.
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");
    const ct = await zip.file("[Content_Types].xml").async("string");
    zip.file("[Content_Types].xml", ct.replace(/<Override[^>]*calcChain[^>]*\/>/, ""));
    const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
    zip.file("xl/_rels/workbook.xml.rels", rels.replace(/<Relationship[^>]*calcChain[^>]*\/>/, ""));
  }
  let wb = await zip.file("xl/workbook.xml").async("string");
  wb = /<calcPr[^>]*fullCalcOnLoad/.test(wb) ? wb : wb.replace(/<calcPr/, '<calcPr fullCalcOnLoad="1"');
  zip.file("xl/workbook.xml", wb);

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
}

// Saca el logo del formato para usarlo en la vista de impresión.
export async function extractLogo(templateBlob) {
  const zip = await JSZip.loadAsync(templateBlob);
  const media = Object.keys(zip.files).filter((p) => p.startsWith("xl/media/"));
  if (!media.length) return null;
  const path = media[0];
  const ext = path.split(".").pop().toLowerCase();
  const type = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
  return new Blob([await zip.file(path).async("arraybuffer")], { type });
}
