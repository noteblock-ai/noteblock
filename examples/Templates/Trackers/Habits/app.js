// Habits.
// Stores: table "habits" = {name: string, archived: boolean};
//         table "checks" = {habitId: string, day: "YYYY-MM-DD"} (one row per habit per done day);
//         kv "seeded" = true once the starter habits exist.
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import html from "htm/react";

const DAYS_SHOWN = 14;
const WEEKS_CHARTED = 8;

const habitsT = quire.store.table("habits");
const checksT = quire.store.table("checks");
const embedded = window.parent !== window.top;

// ---- dates (local time, as YYYY-MM-DD strings) ----
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n));
}
const todayKey = () => dayKey(new Date());
const weekday = (key) => new Date(key + "T12:00").toLocaleDateString("en-US", { weekday: "narrow" });

// ---- streaks ----
// Current streak counts back from today; if today isn't done yet it counts back from yesterday.
function currentStreak(days, today) {
  let d = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}
function bestStreak(days) {
  let best = 0;
  for (const d of days) {
    if (days.has(addDays(d, -1))) continue; // only start counting at the first day of a run
    let n = 0, cur = d;
    while (days.has(cur)) { n++; cur = addDays(cur, 1); }
    best = Math.max(best, n);
  }
  return best;
}

// ---- seed ----
async function seedOnce() {
  if (await quire.kv.get("seeded")) return;
  await quire.kv.set("seeded", true);
  if ((await habitsT.all()).length) return;
  for (const name of ["Walk 30 minutes", "Read 20 pages", "Stretch"]) await habitsT.insert({ name, archived: false });
}

// ---- weekly completion chart (fixed-height bars; labels stay at text size) ----
function WeekChart({ weeks }) {
  return html`<div className="chart" role="img"
      aria-label=${"Weekly completion: " + weeks.map((x) => Math.round(x.rate * 100) + "%").join(", ")}>
    ${weeks.map((wk, i) => html`<div className="col" key=${wk.start}>
      <div className="track"><div className="bar" style=${{ height: Math.round(wk.rate * 100) + "%" }}></div></div>
      <span className="label">${i === weeks.length - 1 ? "now" : wk.label}</span>
    </div>`)}
  </div>`;
}

function App() {
  const [habits, setHabits] = useState(null);
  const [checks, setChecks] = useState([]);
  const [readOnly, setReadOnly] = useState(!!quire.page.readOnly);
  const [name, setName] = useState("");

  async function load() {
    const [h, c] = await Promise.all([habitsT.all(), checksT.all()]);
    h.sort((a, b) => a._created - b._created);
    setHabits(h);
    setChecks(c);
    setReadOnly(!!quire.page.readOnly);
  }
  async function write(fn) {
    try { await fn(); } catch (err) { console.warn("Habits:", err?.message || err); setReadOnly(true); }
    await load();
  }

  useEffect(() => {
    const offs = [];
    (async () => {
      await quire.ready;
      if (!quire.page.readOnly) await seedOnce().catch(() => setReadOnly(true));
      await load();
      offs.push(habitsT.subscribe(load), checksT.subscribe(load));
    })();
    const onMessage = (e) => {
      const m = e.data;
      if (!m || m.quire !== 1) return;
      if (m.type === "mode") setReadOnly(!!m.readOnly);
    };
    window.addEventListener("message", onMessage);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("message", onMessage);
    };
  }, []);

  if (!habits) return null;

  const today = todayKey();
  const active = habits.filter((h) => !h.archived);
  const archived = habits.filter((h) => h.archived);
  const daysByHabit = new Map(habits.map((h) => [h.id, new Set()]));
  const checkId = new Map(); // "habitId|day" -> check row id
  for (const c of checks) {
    daysByHabit.get(c.habitId)?.add(c.day);
    checkId.set(c.habitId + "|" + c.day, c.id);
  }
  const shown = Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(today, i - DAYS_SHOWN + 1));
  const doneToday = active.filter((h) => daysByHabit.get(h.id).has(today)).length;
  const longest = active.reduce((m, h) => Math.max(m, currentStreak(daysByHabit.get(h.id), today)), 0);

  // Week k ends today - 7k; rate = checks in that week / (active habits × 7).
  const weeks = Array.from({ length: WEEKS_CHARTED }, (_, i) => {
    const end = addDays(today, -7 * (WEEKS_CHARTED - 1 - i));
    const start = addDays(end, -6);
    let done = 0;
    for (const h of active) for (let d = start; d <= end; d = addDays(d, 1)) if (daysByHabit.get(h.id).has(d)) done++;
    const label = new Date(start + "T12:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
    return { start, label, rate: active.length ? done / (active.length * 7) : 0 };
  });

  const toggle = (habitId, day) => {
    const id = checkId.get(habitId + "|" + day);
    write(() => (id ? checksT.remove(id) : checksT.insert({ habitId, day })));
  };
  const addHabit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setName("");
    write(() => habitsT.insert({ name: n, archived: false }));
  };

  return html`<div className=${embedded ? "habits" : "habits full"}>
    ${!embedded && html`<h1>${quire.page.title || "Habits"}</h1>`}

    <div className="cards">
      <div className="card">
        <div className="big">${doneToday}/${active.length}</div>
        <div className="sub">done today</div>
      </div>
      <div className="card">
        <div className="big">${longest}d</div>
        <div className="sub">longest current streak</div>
      </div>
    </div>

    <section>
      <h2>Last ${DAYS_SHOWN} days</h2>
      <div className="grid-wrap">
        <table className="grid">
          <thead><tr>
            <th></th>
            ${shown.map((d) => html`<th key=${d} className=${d === today ? "today" : ""} title=${d}>${weekday(d)}</th>`)}
            <th className="streak">now / best</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${active.map((h) => {
              const days = daysByHabit.get(h.id);
              return html`<tr key=${h.id}>
                <th className="name" scope="row">${h.name}</th>
                ${shown.map((d) => html`<td key=${d} className="cell">
                  <button type="button" className=${days.has(d) ? "tick on" : "tick"} disabled=${readOnly}
                    aria-pressed=${days.has(d)} aria-label=${`${h.name}, ${d}`} onClick=${() => toggle(h.id, d)}></button>
                </td>`)}
                <td className="streak">${currentStreak(days, today)} / ${bestStreak(days)}</td>
                <td>${!readOnly && html`<button type="button" className="archive"
                  onClick=${() => write(() => habitsT.update(h.id, { archived: true }))}>Archive</button>`}</td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
      ${active.length === 0 && html`<p className="muted">No habits yet.</p>`}
    </section>

    ${!readOnly && html`<form className="add" onSubmit=${addHabit}>
      <input placeholder="New habit" aria-label="New habit" value=${name} onChange=${(e) => setName(e.target.value)} />
      <button type="submit" disabled=${!name.trim()}>Add</button>
    </form>`}

    <section>
      <h2>Weekly completion</h2>
      <${WeekChart} weeks=${weeks} />
    </section>

    ${archived.length > 0 && html`<details className="archived">
      <summary>Archived (${archived.length})</summary>
      <ul>${archived.map((h) => html`<li key=${h.id}>${h.name}
        ${!readOnly && html` <button type="button" onClick=${() => write(() => habitsT.update(h.id, { archived: false }))}>Restore</button>`}
      </li>`)}</ul>
    </details>`}
  </div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
