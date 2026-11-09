// Trip budget.
// Stores: table "lines" = {label: string, amount: number}; kv "limit" = number (default 3000);
// kv "seeded" = true once the starter lines have been written.
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import html from "htm/react";

const SEED = [
  { label: "Flights", amount: 1240 },
  { label: "Ryokan, 3 nights", amount: 690 },
  { label: "Rail pass ×2", amount: 340 },
  { label: "Food", amount: 400 },
];
const DEFAULT_LIMIT = 3000;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const lines = quire.store.table("lines");
// Embedded pages sit one frame deeper than the page the app opens on.
const embedded = window.parent !== window.top;

function parseAmount(text) {
  const n = Number(String(text).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function seedOnce() {
  if (await quire.kv.get("seeded")) return;
  await quire.kv.set("seeded", true);
  if ((await lines.all()).length) return;
  for (const line of SEED) await lines.insert(line);
}

// An input that edits locally and saves on blur or Enter.
function Field({ value, onSave, className, disabled, format = (v) => v, ...rest }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? format(value);
  const commit = () => {
    if (draft !== null && draft !== format(value)) onSave(draft);
    setDraft(null);
  };
  return html`<input
    ...${rest}
    className=${className}
    value=${shown}
    disabled=${disabled}
    onFocus=${() => setDraft(String(value))}
    onChange=${(e) => setDraft(e.target.value)}
    onBlur=${commit}
    onKeyDown=${(e) => {
      if (e.key === "Enter") e.target.blur();
      if (e.key === "Escape") { setDraft(null); e.target.blur(); }
    }}
  />`;
}

function App() {
  const [rows, setRows] = useState(null);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [readOnly, setReadOnly] = useState(!!quire.page.readOnly);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");

  async function load() {
    const all = await lines.all();
    all.sort((a, b) => a._created - b._created);
    setRows(all);
    const l = await quire.kv.get("limit");
    setLimit(typeof l === "number" ? l : DEFAULT_LIMIT);
    setReadOnly(!!quire.page.readOnly);
  }

  // Every write goes through here: a rejected write means the page is read-only.
  async function write(fn) {
    try {
      await fn();
    } catch (err) {
      console.warn("Trip budget:", err?.message || err);
      setReadOnly(true);
    }
    await load();
  }

  useEffect(() => {
    let off = () => {};
    (async () => {
      await quire.ready;
      if (!quire.page.readOnly) await seedOnce().catch(() => setReadOnly(true));
      await load();
      // Fires after writes from any frame: this page, the embed, or the full page.
      off = lines.subscribe(load);
    })();
    const onMessage = (e) => {
      const m = e.data;
      if (m && m.quire === 1 && m.type === "mode") setReadOnly(!!m.readOnly);
      // kv writes have no subscribe(), so also reload on any store change the renderer reports for this page.
      if (m && m.quire === 1 && m.type === "store-changed" && m.page === quire.page.path) load();
    };
    window.addEventListener("message", onMessage);
    return () => { off(); window.removeEventListener("message", onMessage); };
  }, []);

  if (!rows) return null;

  const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const pct = limit > 0 ? Math.min(100, (total / limit) * 100) : 100;
  const over = total > limit;

  const addLine = (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    const row = { label: label.trim(), amount: parseAmount(amount) };
    setLabel(""); setAmount("");
    write(() => lines.insert(row));
  };

  return html`<div className=${embedded ? "budget" : "budget full"}>
    ${!embedded && html`<h1>Trip budget</h1>`}
    ${rows.map((r) => html`<div className="row" key=${r.id}>
      <${Field} className="label" aria-label="Item" value=${r.label} disabled=${readOnly}
        onSave=${(v) => write(() => lines.update(r.id, { label: v.trim() || r.label }))} />
      <${Field} className="amount" aria-label="Amount" inputMode="decimal" value=${r.amount} disabled=${readOnly}
        format=${(v) => money.format(v)}
        onSave=${(v) => write(() => lines.update(r.id, { amount: parseAmount(v) }))} />
      <button className="del" type="button" aria-label=${"Delete " + r.label} disabled=${readOnly}
        onClick=${() => write(() => lines.remove(r.id))}>×</button>
    </div>`)}
    ${!readOnly && html`<form className="add" onSubmit=${addLine}>
      <input className="label" placeholder="Add a line" aria-label="New item" value=${label}
        onChange=${(e) => setLabel(e.target.value)} />
      <input className="amount" placeholder="$0" aria-label="New amount" inputMode="decimal" value=${amount}
        onChange=${(e) => setAmount(e.target.value)} />
      <button type="submit" disabled=${!label.trim()}>Add</button>
    </form>`}
    <div className="total">
      <span className="name">Total</span>
      <span className="mono">${money.format(total)} of</span>
      <${Field} className="limit" aria-label="Budget limit" inputMode="decimal" value=${limit} disabled=${readOnly}
        format=${(v) => money.format(v)}
        onSave=${(v) => write(() => quire.kv.set("limit", parseAmount(v)))} />
    </div>
    <div className=${over ? "bar over" : "bar"} role="progressbar" aria-valuemin="0" aria-valuemax=${limit} aria-valuenow=${total}>
      <div style=${{ width: pct + "%" }}></div>
    </div>
    <div className=${over ? "note over" : "note"}>
      ${over ? money.format(total - limit) + " over" : money.format(limit - total) + " left"}
    </div>
  </div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
