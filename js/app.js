import { db, getSetting, setSetting, uid, requestPersistence } from "./db.js";
import { readReceipt, translateToEnglish, CATEGORIES } from "./claude.js";
import { rateToUSD, rateUSDtoHNL, saveBCHRate, convert, round2 } from "./rates.js";
import { fillTemplate, extractLogo, rowDate } from "./xlsx.js";
import { liquidationHTML, annexHTML, elementToPDF } from "./print.js";
import { prepareImage, shareOrDownload, tripZip, tripFolderName, receiptFileName } from "./files.js";

const app = document.getElementById("app");

// ---------- utilidades ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => Array.from(root.querySelectorAll(sel));

function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ""), 4000);
}

async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

async function tripExpenses(tripId) {
  const list = await db.byIndex("expenses", "tripId", tripId);
  return list.sort((a, b) => (a.date === b.date ? a.createdAt - b.createdAt : a.date < b.date ? -1 : 1));
}

function totals(trip, expenses) {
  const spent = round2(expenses.reduce((s, e) => s + (Number(e.hnl) || 0), 0));
  const budget = Number(trip.budgetHNL) || 0;
  return { spent, budget, left: round2(budget - spent), pct: budget ? spent / budget : 0 };
}

const objectURLs = [];
function blobURL(blob) {
  const url = URL.createObjectURL(blob);
  objectURLs.push(url);
  return url;
}
function releaseURLs() {
  while (objectURLs.length) URL.revokeObjectURL(objectURLs.pop());
}

// ---------- rutas ----------

const routes = [
  [/^\/?$/, home],
  [/^\/viaje\/nuevo$/, () => tripForm(null)],
  [/^\/viaje\/([^/]+)$/, (id) => tripView(id)],
  [/^\/viaje\/([^/]+)\/editar$/, (id) => tripForm(id)],
  [/^\/viaje\/([^/]+)\/editar\/desde\/(liquidacion|anexo)$/, (id, from) => tripForm(id, from)],
  [/^\/viaje\/([^/]+)\/gasto$/, (id) => expenseForm(id, null)],
  [/^\/gasto\/([^/]+)$/, (id) => expenseForm(null, id)],
  [/^\/gasto\/([^/]+)\/desde\/(liquidacion|anexo)$/, (id, from) => expenseForm(null, id, from)],
  [/^\/viaje\/([^/]+)\/liquidacion$/, (id) => liquidationView(id)],
  [/^\/viaje\/([^/]+)\/anexo$/, (id) => annexView(id)],
  [/^\/ajustes$/, settingsView],
];

async function render() {
  releaseURLs();
  const path = location.hash.replace(/^#/, "") || "/";
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (m) {
      try {
        await fn(...m.slice(1));
      } catch (e) {
        console.error(e);
        app.innerHTML = `<p class="error">Ocurrió un error: ${esc(e.message)}</p><a class="btn" href="#/">Volver</a>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = "#/";
}

window.addEventListener("hashchange", render);

// ---------- inicio ----------

async function home() {
  const trips = (await db.all("trips")).sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  const hasKey = !!(await getSetting("apiKey"));
  const hasTemplate = !!(await db.get("blobs", "template"));
  const open = trips.filter((t) => t.status !== "closed");
  const closed = trips.filter((t) => t.status === "closed");

  const card = async (t) => {
    const { spent, budget, left } = totals(t, await tripExpenses(t.id));
    return `<a class="card trip" href="#/viaje/${t.id}">
      <div><strong>${esc(t.name)}</strong><span class="muted">${esc(t.purpose || "")}</span></div>
      <div class="muted">${rowDate(t.startDate)}${t.endDate ? " al " + rowDate(t.endDate) : ""}</div>
      <div class="nums"><span>Gastado L ${money(spent)}</span><span>Presupuesto L ${money(budget)}</span>
      <span class="${left < 0 ? "neg" : ""}">Saldo L ${money(left)}</span></div>
    </a>`;
  };

  app.innerHTML = `
    ${!hasKey || !hasTemplate ? `<div class="notice">
      Antes de empezar, ve a <a href="#/ajustes">Ajustes</a> ${!hasKey ? "y agrega tu clave de Claude" : ""}
      ${!hasKey && !hasTemplate ? " y " : ""}${!hasTemplate ? "carga tu formato de liquidación (.xlsx)" : ""}.
    </div>` : ""}
    <div class="row-between"><h1>Viajes</h1><a class="btn primary" href="#/viaje/nuevo">Nuevo viaje</a></div>
    ${open.length ? (await Promise.all(open.map(card))).join("") : `<p class="muted">No tienes viajes abiertos.</p>`}
    ${closed.length ? `<h2>Cerrados</h2>${(await Promise.all(closed.map(card))).join("")}` : ""}
  `;
}

// ---------- viaje ----------

async function tripForm(id, from = null) {
  const trip = id ? await db.get("trips", id) : null;
  const t = trip || {
    employeeName: await getSetting("employeeName", ""),
    programCode: await getSetting("programCode", ""),
    accountCode: await getSetting("accountCode", ""),
    startDate: today(),
    foodReport: false,
    deposit: false,
  };
  app.innerHTML = `
    <h1>${trip ? "Editar viaje" : "Nuevo viaje"}</h1>
    <form id="f" class="form">
      <label>Nombre del viaje<input name="name" required value="${esc(t.name)}" placeholder="Houston noviembre 2026"></label>
      <label>Objetivo del viaje<textarea name="purpose" rows="2">${esc(t.purpose)}</textarea></label>
      <div class="two">
        <label>Fecha de inicio<input type="date" name="startDate" required value="${esc(t.startDate)}"></label>
        <label>Fecha final<input type="date" name="endDate" value="${esc(t.endDate)}"></label>
      </div>
      <label>Presupuesto asignado (Valor Transferencia, L)
        <input name="budgetHNL" inputmode="decimal" required value="${esc(t.budgetHNL)}" placeholder="9300.00"></label>
      <label>Nombre del empleado<input name="employeeName" value="${esc(t.employeeName)}"></label>
      <div class="two">
        <label>Número de Solicitud<input name="requestNumber" value="${esc(t.requestNumber)}"></label>
        <label>Número de Referencia<input name="referenceNumber" value="${esc(t.referenceNumber)}"></label>
      </div>
      <div class="two">
        <label>Código de programa (por defecto)<input name="programCode" value="${esc(t.programCode)}"></label>
        <label>Código de cuenta (por defecto)<input name="accountCode" value="${esc(t.accountCode)}"></label>
      </div>
      <fieldset><legend>Documentación de soporte</legend>
        <label class="check"><input type="checkbox" name="foodReport" ${t.foodReport ? "checked" : ""}> Reporte de Alimentación</label>
        <label class="check"><input type="checkbox" name="deposit" ${t.deposit ? "checked" : ""}> Depósito</label>
      </fieldset>
      <div class="actions">
        <button class="btn primary" type="submit">Guardar</button>
        <a class="btn" href="${trip ? `#/viaje/${trip.id}${from ? "/" + from : ""}` : "#/"}">Cancelar</a>
        ${trip ? `<button class="btn danger" type="button" id="del">Eliminar viaje</button>` : ""}
      </div>
    </form>`;

  $("#f").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const data = Object.fromEntries(fd.entries());
    const saved = {
      ...(trip || { id: uid(), status: "open", createdAt: Date.now() }),
      ...data,
      budgetHNL: round2(String(data.budgetHNL).replace(/,/g, "")),
      foodReport: fd.has("foodReport"),
      deposit: fd.has("deposit"),
    };
    await db.put("trips", saved);
    if (data.employeeName) await setSetting("employeeName", data.employeeName);
    location.hash = `#/viaje/${saved.id}${from ? "/" + from : ""}`;
  });
  $("#del")?.addEventListener("click", async () => {
    const list = await tripExpenses(trip.id);
    if (!confirm(`¿Eliminar el viaje "${trip.name}" y sus ${list.length} gastos? Esto no se puede deshacer.`)) return;
    for (const e of list) {
      if (e.blobId) await db.del("blobs", e.blobId);
      await db.del("expenses", e.id);
    }
    await db.del("trips", trip.id);
    location.hash = "#/";
  });
}

async function tripView(id) {
  const trip = await db.get("trips", id);
  if (!trip) return (location.hash = "#/");
  const expenses = await tripExpenses(id);
  const { spent, budget, left, pct } = totals(trip, expenses);
  const pending = expenses.filter((e) => e.currency !== "HNL" && (!e.rateHNL || !e.rateToUSD));
  const closed = trip.status === "closed";

  app.innerHTML = `
    <div class="row-between">
      <div><h1>${esc(trip.name)}</h1><p class="muted">${esc(trip.purpose || "")}</p>
      <p class="muted">${rowDate(trip.startDate)}${trip.endDate ? " al " + rowDate(trip.endDate) : ""}${closed ? " · Cerrado" : ""}</p></div>
      <a class="btn small" href="#/viaje/${id}/editar">Editar</a>
    </div>
    <div class="summary">
      <div><span>Presupuesto</span><strong>L ${money(budget)}</strong></div>
      <div><span>Gastado</span><strong>L ${money(spent)}</strong></div>
      <div class="${left < 0 ? "neg" : ""}"><span>${left < 0 ? "Excedido" : "Disponible"}</span><strong>L ${money(left)}</strong></div>
      <div class="meter"><i style="width:${Math.min(100, pct * 100).toFixed(1)}%" class="${pct >= 1 ? "over" : pct >= 0.8 ? "warn" : ""}"></i></div>
      ${pct >= 0.8 && pct < 1 ? `<p class="warn-text">Ya usaste el ${(pct * 100).toFixed(0)}% del presupuesto.</p>` : ""}
    </div>
    ${closed ? "" : `<a class="btn primary big" href="#/viaje/${id}/gasto">+ Registrar gasto</a>`}
    ${pending.length ? `<div class="notice">${pending.length} gasto(s) sin tasa de cambio.
      <button class="btn small" id="fixRates">Calcular tasas pendientes</button></div>` : ""}
    <h2>Gastos (${expenses.length})</h2>
    <ol class="expenses">
      ${expenses.map((e, i) => `
        <li><a href="#/gasto/${e.id}">
          <span class="n">${i + 1}</span>
          <span class="main"><strong>${esc(e.merchant || "Sin proveedor")}</strong>
            <span class="muted">${rowDate(e.date)} · ${esc(e.descEs || "")}</span></span>
          <span class="amt">L ${money(e.hnl)}<span class="muted">${money(e.amount)} ${esc(e.currency)}</span></span>
        </a></li>`).join("") || `<p class="muted">Todavía no hay gastos.</p>`}
    </ol>
    <h2>Documentos</h2>
    <div class="actions wrap">
      <a class="btn" href="#/viaje/${id}/liquidacion">Liquidación</a>
      <a class="btn" href="#/viaje/${id}/anexo">Comprobantes (una hoja por factura)</a>
      <button class="btn" id="zip">Guardar carpeta del viaje</button>
      <button class="btn ${closed ? "" : "danger"}" id="close">${closed ? "Reabrir viaje" : "Cerrar viaje"}</button>
    </div>`;

  $("#fixRates")?.addEventListener("click", (ev) =>
    busy(ev.target, "Calculando…", async () => {
      let ok = 0;
      for (const e of pending) {
        try {
          const r1 = await rateToUSD(e.currency, e.date);
          const r2 = await rateUSDtoHNL(e.date);
          Object.assign(e, { rateToUSD: r1.rate, rateToUSDSource: r1.source, rateHNL: r2.rate, rateHNLSource: r2.source },
            convert(e.amount, r1.rate, r2.rate));
          await db.put("expenses", e);
          ok++;
        } catch (err) {
          toast(err.message, "error");
        }
      }
      toast(`${ok} gasto(s) actualizados.`);
      render();
    })
  );
  $("#zip").addEventListener("click", (ev) => busy(ev.target, "Preparando…", () => exportTrip(trip, expenses)));
  $("#close").addEventListener("click", async () => {
    if (closed) {
      trip.status = "open";
      delete trip.closedAt;
    } else {
      if (!confirm("¿Cerrar el viaje? Podrás reabrirlo si necesitas corregir algo.")) return;
      trip.status = "closed";
      trip.closedAt = Date.now();
      if (!trip.endDate && expenses.length) trip.endDate = expenses[expenses.length - 1].date;
    }
    await db.put("trips", trip);
    if (!closed) location.hash = `#/viaje/${id}/liquidacion`;
    else render();
  });
}

async function exportTrip(trip, expenses) {
  const blobs = {};
  for (const e of expenses) {
    if (e.blobId) {
      const b = await db.get("blobs", e.blobId);
      if (b) blobs[e.id] = b.blob;
    }
  }
  const extras = {};
  const template = await db.get("blobs", "template");
  if (template) extras["Liquidacion.xlsx"] = await fillTemplate(template.blob, trip, expenses, { orientation: "landscape" });
  const zip = await tripZip(trip, expenses, blobs, extras);
  await shareOrDownload(zip, `${tripFolderName(trip)}.zip`);
}

// ---------- gasto ----------

// `from` devuelve a la liquidación o a los comprobantes después de corregir el gasto.
async function expenseForm(tripId, expenseId, from = null) {
  const existing = expenseId ? await db.get("expenses", expenseId) : null;
  tripId = tripId || existing?.tripId;
  const trip = await db.get("trips", tripId);
  if (!trip) return (location.hash = "#/");
  const back = `#/viaje/${trip.id}${from ? "/" + from : ""}`;

  const e = existing || {
    date: today() < trip.startDate ? trip.startDate : today(),
    currency: "USD",
    paymentMethod: "Tarjeta",
    category: "Alimentación",
    programCode: trip.programCode || "",
    accountCode: trip.accountCode || "",
    tip: 0,
  };
  let blob = null;
  if (existing?.blobId) blob = (await db.get("blobs", existing.blobId))?.blob || null;
  let blobChanged = false;
  let enAuto = !existing;
  const dirty = { rateToUSD: !!existing, rateHNL: !!existing };

  app.innerHTML = `
    <h1>${existing ? "Revisar gasto" : "Nuevo gasto"}</h1>
    <p class="muted">${esc(trip.name)}</p>
    <section class="capture">
      <div id="preview" class="preview">${blob ? "" : `<span class="muted">Sin comprobante</span>`}</div>
      <div class="actions wrap">
        <label class="btn primary">Tomar foto<input type="file" accept="image/*" capture="environment" id="cam" hidden></label>
        <label class="btn">Foto, captura o PDF<input type="file" accept="image/*,application/pdf" id="pick" hidden></label>
        <button class="btn" type="button" id="read" ${blob ? "" : "hidden"}>Leer con Claude</button>
      </div>
      <p id="status" class="muted"></p>
      <p id="notes" class="notice" hidden></p>
    </section>

    <form id="f" class="form">
      <p class="muted">Revisa y corrige cualquier dato antes de registrar.</p>
      <div class="two">
        <label>Fecha<input type="date" name="date" required value="${esc(e.date)}"></label>
        <label>Método de pago<select name="paymentMethod">
          ${["Tarjeta", "Efectivo", "Desconocido"].map((m) => `<option ${m === e.paymentMethod ? "selected" : ""}>${m}</option>`).join("")}
        </select></label>
      </div>
      <label>Comercio o servicio (proveedor)<input name="merchant" required value="${esc(e.merchant)}"></label>
      <label>Número de factura o recibo<input name="invoice" value="${esc(e.invoice)}"></label>
      <div class="two">
        <label>País<input name="country" value="${esc(e.country)}"></label>
        <label>Ciudad<input name="city" value="${esc(e.city)}"></label>
      </div>
      <div class="two">
        <label>Monto total pagado<input name="amount" inputmode="decimal" required value="${esc(e.amount)}"></label>
        <label>Moneda<input name="currency" required maxlength="3" value="${esc(e.currency)}" class="upper"></label>
      </div>
      <label>Propina incluida en el total<input name="tip" inputmode="decimal" value="${esc(e.tip || 0)}"></label>
      <label>Categoría<select name="category">
        ${CATEGORIES.map((c) => `<option ${c === e.category ? "selected" : ""}>${c}</option>`).join("")}
      </select></label>
      <label>Concepto en español<textarea name="descEs" rows="2" required>${esc(e.descEs)}</textarea></label>
      <label>Concepto en inglés
        <span class="inline"><textarea name="descEn" rows="2">${esc(e.descEn)}</textarea>
        <button class="btn small" type="button" id="tr">Traducir</button></span></label>
      <div class="two">
        <label>Código de programa<input name="programCode" value="${esc(e.programCode)}"></label>
        <label>Código de cuenta<input name="accountCode" value="${esc(e.accountCode)}"></label>
      </div>
      <label class="check"><input type="checkbox" name="noReceipt" ${e.noReceipt ? "checked" : ""}> Gasto sin comprobante (propina, taxi en efectivo…)</label>
      <label id="nrNote" ${e.noReceipt ? "" : "hidden"}>Nota del gasto sin comprobante<input name="noReceiptNote" value="${esc(e.noReceiptNote)}"></label>

      <fieldset class="conv"><legend>Conversión a lempiras</legend>
        <p id="isHNL" class="muted" hidden>Gasto en lempiras: va directo con su valor original, sin conversión.</p>
        <div class="two" data-fx>
          <label><span id="lblUSD">Tasa a USD</span><input name="rateToUSD" inputmode="decimal" value="${esc(e.rateToUSD)}"></label>
          <label>Monto en USD<input name="usd" readonly value="${esc(e.usd)}"></label>
        </div>
        <div class="two">
          <label data-fx>Tasa USD → HNL<input name="rateHNL" inputmode="decimal" value="${esc(e.rateHNL)}"></label>
          <label>Monto en lempiras<input name="hnl" readonly value="${esc(e.hnl)}" class="strong"></label>
        </div>
        <p class="muted small" id="rateSrc" data-fx>${esc(e.rateHNLSource || "")}</p>
        <label class="check" data-fx><input type="checkbox" name="bch" ${e.rateHNLSource === "BCH" ? "checked" : ""}> Esta es la tasa oficial del BCH para esta fecha</label>
        <button class="btn small" type="button" id="rates" data-fx>Actualizar tasas</button>
      </fieldset>

      <div class="actions">
        <button class="btn primary big" type="submit">Registrar</button>
        <a class="btn" href="${back}">Cancelar</a>
        ${existing ? `<button class="btn danger" type="button" id="del">Eliminar</button>` : ""}
      </div>
    </form>`;

  const form = $("#f");
  const field = (n) => form.elements[n];
  const status = $("#status");
  const sources = { usd: e.rateToUSDSource || "", hnl: e.rateHNLSource || "" };

  function showPreview() {
    const p = $("#preview");
    if (!blob) return (p.innerHTML = `<span class="muted">Sin comprobante</span>`);
    p.innerHTML = blob.type === "application/pdf"
      ? `<div class="pdf">Comprobante PDF</div>`
      : `<img src="${blobURL(blob)}" alt="Comprobante">`;
    $("#read").hidden = false;
  }
  showPreview();

  const isHNL = () => field("currency").value.trim().toUpperCase() === "HNL";

  function recalc() {
    const amount = Number(String(field("amount").value).replace(/,/g, ""));
    const local = isHNL();
    $("#isHNL").hidden = !local;
    $$("[data-fx]").forEach((el) => (el.hidden = local));
    if (local) {
      field("usd").value = "";
      field("hnl").value = amount ? amount.toFixed(2) : "";
      return;
    }
    const r1 = Number(field("rateToUSD").value);
    const r2 = Number(field("rateHNL").value);
    if (amount && r1 && r2) {
      const { usd, hnl } = convert(amount, r1, r2);
      field("usd").value = usd.toFixed(2);
      field("hnl").value = hnl.toFixed(2);
    } else {
      field("usd").value = "";
      field("hnl").value = "";
    }
    $("#lblUSD").textContent = `Tasa ${field("currency").value.toUpperCase() || "moneda"} → USD`;
  }

  async function loadRates(force = false) {
    const date = field("date").value;
    const cur = field("currency").value.toUpperCase();
    if (!date || cur.length !== 3) return;
    if (cur === "HNL") return recalc();
    status.textContent = "Buscando tasas del " + rowDate(date) + "…";
    try {
      if (force || !dirty.rateToUSD) {
        const r = await rateToUSD(cur, date);
        field("rateToUSD").value = r.rate;
        sources.usd = r.source;
      }
      if (force || !dirty.rateHNL) {
        const r = await rateUSDtoHNL(date);
        field("rateHNL").value = r.rate;
        sources.hnl = r.source;
        field("bch").checked = !!r.bch;
      }
      $("#rateSrc").textContent = `A USD: ${sources.usd} · A HNL: ${sources.hnl}`;
      status.textContent = "";
    } catch (err) {
      status.textContent = err.message + " Puedes escribir las tasas a mano o calcularlas después.";
    }
    recalc();
  }

  async function onFile(file) {
    if (!file) return;
    blob = await prepareImage(file);
    blobChanged = true;
    showPreview();
    await runRead();
  }

  async function runRead() {
    if (!blob) return;
    if (!navigator.onLine) {
      status.textContent = "Sin conexión: la foto queda guardada. Llena los datos a mano o lee el recibo cuando vuelva la señal.";
      return;
    }
    const btn = $("#read");
    await busy(btn, "Leyendo…", async () => {
      status.textContent = "Claude está leyendo el comprobante…";
      try {
        const r = await readReceipt(blob);
        const set = (n, v) => {
          if (v !== undefined && v !== null && v !== "") field(n).value = v;
        };
        set("date", r.date);
        set("merchant", r.merchant);
        set("invoice", r.invoice_number);
        set("country", r.country);
        set("city", r.city);
        set("amount", r.amount || "");
        set("currency", (r.currency || "").toUpperCase());
        set("tip", r.tip || 0);
        if (r.payment_method) field("paymentMethod").value = r.payment_method;
        if (r.category) field("category").value = r.category;
        if (!field("descEs").value) set("descEs", r.description_es);
        if (!field("descEn").value || enAuto) {
          set("descEn", r.description_en);
          enAuto = true;
        }
        const notes = $("#notes");
        notes.hidden = !r.notes;
        notes.textContent = r.notes ? "Revisa: " + r.notes : "";
        status.textContent = "Listo. Revisa los datos y corrige lo que haga falta.";
        dirty.rateToUSD = false;
        dirty.rateHNL = false;
        await loadRates();
      } catch (err) {
        status.textContent = err.message;
      }
    });
  }

  $("#cam").addEventListener("change", (ev) => onFile(ev.target.files[0]));
  $("#pick").addEventListener("change", (ev) => onFile(ev.target.files[0]));
  $("#read").addEventListener("click", runRead);
  field("noReceipt").addEventListener("change", () => ($("#nrNote").hidden = !field("noReceipt").checked));

  for (const n of ["amount"]) field(n).addEventListener("input", recalc);
  field("rateToUSD").addEventListener("input", () => {
    dirty.rateToUSD = true;
    sources.usd = "Manual";
    recalc();
  });
  field("rateHNL").addEventListener("input", () => {
    dirty.rateHNL = true;
    sources.hnl = "Manual";
    recalc();
  });
  field("date").addEventListener("change", () => {
    dirty.rateToUSD = false;
    dirty.rateHNL = false;
    loadRates();
  });
  field("currency").addEventListener("change", () => {
    dirty.rateToUSD = false;
    loadRates();
  });
  field("currency").addEventListener("input", recalc);
  $("#rates").addEventListener("click", () => loadRates(true));

  async function translate() {
    const es = field("descEs").value.trim();
    if (!es) return;
    const btn = $("#tr");
    await busy(btn, "…", async () => {
      try {
        field("descEn").value = await translateToEnglish(es);
        enAuto = true;
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
  $("#tr").addEventListener("click", translate);
  field("descEs").addEventListener("change", () => {
    if ((enAuto || !field("descEn").value.trim()) && navigator.onLine) translate();
  });
  field("descEn").addEventListener("input", () => (enAuto = false));

  if (!existing) loadRates();
  else recalc();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(form).entries());
    const amount = round2(String(fd.amount).replace(/,/g, ""));
    if (!amount) return toast("Escribe el monto del gasto.", "error");
    const local = fd.currency.trim().toUpperCase() === "HNL";
    const rate1 = local ? null : Number(fd.rateToUSD) || null;
    const rate2 = local ? null : Number(fd.rateHNL) || null;

    if (fd.date < trip.startDate || (trip.endDate && fd.date > trip.endDate)) {
      if (!confirm(`La fecha ${rowDate(fd.date)} está fuera del viaje. ¿Registrar de todos modos?`)) return;
    }
    const others = (await tripExpenses(trip.id)).filter((x) => x.id !== existing?.id);
    const dup = others.find((x) =>
      Number(x.amount) === amount && x.currency === fd.currency.toUpperCase() &&
      ((fd.invoice && x.invoice === fd.invoice) || (x.date === fd.date && (x.merchant || "").toLowerCase() === fd.merchant.toLowerCase())));
    if (dup && !confirm(`Parece repetido: ${dup.merchant} del ${rowDate(dup.date)} por ${money(dup.amount)} ${dup.currency}. ¿Registrar de todos modos?`)) return;

    const saved = {
      ...(existing || { id: uid(), tripId: trip.id, createdAt: Date.now() }),
      date: fd.date,
      merchant: fd.merchant.trim(),
      invoice: fd.invoice.trim(),
      country: fd.country.trim(),
      city: fd.city.trim(),
      amount,
      currency: fd.currency.toUpperCase().trim(),
      tip: round2(fd.tip || 0),
      paymentMethod: fd.paymentMethod,
      category: fd.category,
      descEs: fd.descEs.trim(),
      descEn: fd.descEn.trim(),
      programCode: fd.programCode.trim(),
      accountCode: fd.accountCode.trim(),
      noReceipt: !!fd.noReceipt,
      noReceiptNote: (fd.noReceiptNote || "").trim(),
      rateToUSD: rate1,
      rateToUSDSource: local ? "No aplica" : sources.usd,
      rateHNL: rate2,
      rateHNLSource: local ? "No aplica" : fd.bch ? "BCH" : sources.hnl,
      // Un gasto en lempiras va directo con su valor original.
      ...(local ? { usd: null, hnl: amount } : rate1 && rate2 ? convert(amount, rate1, rate2) : { usd: null, hnl: null }),
    };
    if (blob && blobChanged) {
      const blobId = saved.blobId || uid();
      await db.put("blobs", { id: blobId, blob });
      saved.blobId = blobId;
      saved.mime = blob.type;
    }
    const seq = others.filter((x) => x.date <= saved.date).length + 1;
    if (saved.blobId) saved.fileName = receiptFileName(saved, seq, saved.mime);
    if (!local && fd.bch && rate2) await saveBCHRate(fd.date, rate2);
    await db.put("expenses", saved);
    toast("Gasto registrado.");
    location.hash = back;
  });

  $("#del")?.addEventListener("click", async () => {
    if (!confirm("¿Eliminar este gasto?")) return;
    if (existing.blobId) await db.del("blobs", existing.blobId);
    await db.del("expenses", existing.id);
    location.hash = back;
  });
}

// ---------- liquidación y anexo ----------

async function orientationBar(key) {
  const o = (await getSetting(key, "landscape")) || "landscape";
  return {
    o,
    html: `<div class="seg" role="radiogroup" aria-label="Orientación">
      <label><input type="radio" name="o" value="portrait" ${o === "portrait" ? "checked" : ""}> Vertical</label>
      <label><input type="radio" name="o" value="landscape" ${o === "landscape" ? "checked" : ""}> Horizontal</label>
    </div>`,
  };
}

function fitPreview(sheet) {
  const box = sheet.parentElement;
  const scale = Math.min(1, box.clientWidth / sheet.offsetWidth);
  sheet.style.transform = `scale(${scale})`;
  box.style.height = sheet.offsetHeight * scale + "px";
}

// Lista para corregir los datos que salen en el documento, sin salir de esta página.
function fixList(trip, expenses, from) {
  const items = expenses
    .map((e, i) => `
        <li><a href="#/gasto/${e.id}/desde/${from}">
          <span class="n">${i + 1}</span>
          <span class="main"><strong>${esc(e.merchant || "Sin proveedor")}</strong>
            <span class="muted">${rowDate(e.date)} · ${esc(e.descEs || "")}</span></span>
          <span class="amt">${e.hnl == null ? "—" : "L " + money(e.hnl)}<span class="muted">Editar</span></span>
        </a></li>`)
    .join("");
  return `
    <details class="fix">
      <summary>Corregir datos</summary>
      <p class="muted small">Toca un gasto para corregirlo. Al guardar regresas aquí con el documento actualizado.</p>
      <ol class="expenses">${items}</ol>
      <a class="btn small" href="#/viaje/${trip.id}/editar/desde/${from}">Datos del viaje (fechas, presupuesto, solicitud, empleado)</a>
    </details>`;
}

async function liquidationView(id) {
  const trip = await db.get("trips", id);
  const expenses = (await tripExpenses(id)).filter((e) => e.hnl != null);
  const missing = (await tripExpenses(id)).length - expenses.length;
  const logo = await db.get("blobs", "logo");
  const template = await db.get("blobs", "template");
  const { o, html } = await orientationBar("liqOrientation");

  app.innerHTML = `
    <div class="row-between"><h1>Liquidación</h1><a class="btn small" href="#/viaje/${id}">Volver</a></div>
    ${missing ? `<div class="notice">${missing} gasto(s) no tienen tasa de cambio y no aparecen. Calcúlalas desde el viaje.</div>` : ""}
    ${template ? "" : `<div class="notice">Para el Excel con el formato original, carga el archivo en <a href="#/ajustes">Ajustes</a>.</div>`}
    ${html}
    <div class="actions wrap">
      <button class="btn primary" id="pdf">Guardar PDF</button>
      <button class="btn" id="xlsx" ${template ? "" : "disabled"}>Guardar Excel (formato original)</button>
    </div>
    ${fixList(trip, await tripExpenses(id), "liquidacion")}
    <div class="paper-box"><div class="paper ${o}" id="sheet">${liquidationHTML(trip, expenses, logo ? blobURL(logo.blob) : "")}</div></div>`;

  const sheet = $("#sheet");
  const fit = () => fitPreview(sheet);
  requestAnimationFrame(fit);
  window.addEventListener("resize", fit, { once: true });
  $$("input[name=o]").forEach((r) =>
    r.addEventListener("change", async () => {
      await setSetting("liqOrientation", r.value);
      sheet.className = "paper " + r.value;
      fit();
    })
  );
  const current = () => $("input[name=o]:checked").value;
  const name = `Liquidación ${trip.name}`.replace(/[\\/:*?"<>|]/g, "-");

  $("#pdf").addEventListener("click", (ev) =>
    busy(ev.target, "Generando…", async () => {
      sheet.style.transform = "none";
      try {
        const pdf = await elementToPDF(sheet, current());
        await shareOrDownload(pdf, `${name}.pdf`);
      } finally {
        fit();
      }
    })
  );
  $("#xlsx").addEventListener("click", (ev) =>
    busy(ev.target, "Generando…", async () => {
      const file = await fillTemplate(template.blob, trip, expenses, { orientation: current() });
      await shareOrDownload(file, `${name}.xlsx`);
    })
  );
}

async function annexView(id) {
  const trip = await db.get("trips", id);
  const expenses = (await tripExpenses(id)).filter((e) => e.hnl != null);
  const urls = {};
  for (const e of expenses) {
    if (!e.blobId) continue;
    const b = await db.get("blobs", e.blobId);
    if (b) urls[e.id] = { url: blobURL(b.blob), pdf: b.blob.type === "application/pdf" };
  }
  const { o, html } = await orientationBar("annexOrientation");
  app.innerHTML = `
    <div class="row-between"><h1>Comprobantes (una hoja por factura)</h1><a class="btn small" href="#/viaje/${id}">Volver</a></div>
    ${html}
    <div class="actions"><button class="btn primary" id="pdf">Guardar PDF</button></div>
    ${fixList(trip, expenses, "anexo")}
    <div class="paper-box"><div class="paper ${o}" id="sheet">${annexHTML(trip, expenses, urls)}</div></div>`;

  const sheet = $("#sheet");
  const fit = () => fitPreview(sheet);
  requestAnimationFrame(fit);
  $$("input[name=o]").forEach((r) =>
    r.addEventListener("change", async () => {
      await setSetting("annexOrientation", r.value);
      sheet.className = "paper " + r.value;
      fit();
    })
  );
  $("#pdf").addEventListener("click", (ev) =>
    busy(ev.target, "Generando…", async () => {
      sheet.style.transform = "none";
      try {
        const orientation = $("input[name=o]:checked").value;
        const pdf = await elementToPDF(sheet.querySelector(".annex"), orientation, { paginate: true });
        await shareOrDownload(pdf, `Comprobantes ${trip.name}.pdf`.replace(/[\\/:*?"<>|]/g, "-"));
      } finally {
        fit();
      }
    })
  );
}

// ---------- ajustes ----------

async function settingsView() {
  const apiKey = await getSetting("apiKey", "");
  const template = await db.get("blobs", "template");
  app.innerHTML = `
    <h1>Ajustes</h1>
    <form id="f" class="form">
      <label>Clave de Claude (API key)
        <input name="apiKey" type="password" autocomplete="off" value="${esc(apiKey)}" placeholder="sk-ant-…"></label>
      <p class="muted small">Se guarda solo en este teléfono y se usa para leer recibos y traducir. La consigues en
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
      <label>Nombre del empleado<input name="employeeName" value="${esc(await getSetting("employeeName", ""))}"></label>
      <div class="two">
        <label>Código de programa habitual<input name="programCode" value="${esc(await getSetting("programCode", ""))}"></label>
        <label>Código de cuenta habitual<input name="accountCode" value="${esc(await getSetting("accountCode", ""))}"></label>
      </div>
      <div class="actions">
        <button class="btn primary" type="submit">Guardar</button>
        <button class="btn" type="button" id="test">Probar conexión</button>
      </div>
    </form>

    <h2>Formato de liquidación</h2>
    <p>${template ? `Cargado: <strong>${esc(template.name || "formato.xlsx")}</strong>.` : "Todavía no has cargado el formato."}
      La app llena una copia de este archivo, así conserva el logo y el diseño original.</p>
    <label class="btn">Cargar formato (.xlsx)<input type="file" id="tpl" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label>

    <h2>Datos</h2>
    <p class="muted small">Todo se guarda en este teléfono. Usa "Guardar carpeta del viaje" en cada viaje para tener una copia en Archivos o iCloud.</p>`;

  $("#f").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(ev.target).entries());
    for (const [k, v] of Object.entries(fd)) await setSetting(k, v.trim());
    toast("Ajustes guardados.");
  });
  $("#test").addEventListener("click", (ev) =>
    busy(ev.target, "Probando…", async () => {
      await setSetting("apiKey", $("#f").elements.apiKey.value.trim());
      try {
        const en = await translateToEnglish("Desayuno");
        toast(`Conexión correcta (Desayuno → ${en}).`);
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );
  $("#tpl").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const logo = await extractLogo(file);
      await db.put("blobs", { id: "template", blob: file, name: file.name });
      if (logo) await db.put("blobs", { id: "logo", blob: logo });
      toast("Formato cargado.");
      render();
    } catch (err) {
      toast("No pude leer ese archivo: " + err.message, "error");
    }
  });
}

// ---------- arranque ----------

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
requestPersistence();
window.addEventListener("offline", () => toast("Sin conexión. Puedes seguir registrando gastos."));
render();
