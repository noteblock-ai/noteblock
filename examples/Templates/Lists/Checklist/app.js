// Checklist, plain JS (no React).
// Stores: table "items" = {label: string, done: boolean}.

const items = quire.store.table("items");
const root = document.getElementById("root");
const embedded = window.parent !== window.top;
let readOnly = !!quire.page.readOnly;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// A rejected write means the page went read-only (Claude is editing it).
async function write(fn) {
  try {
    await fn();
  } catch (err) {
    console.warn("Checklist:", err?.message || err);
    readOnly = true;
  }
  await render();
}

async function render() {
  const rows = (await items.all()).sort((a, b) => a._created - b._created);
  const packed = rows.filter((r) => r.done).length;
  readOnly = readOnly || !!quire.page.readOnly;

  const list = el("ul", {}, ...rows.map((r) => {
    const box = el("input", { type: "checkbox", checked: !!r.done, disabled: readOnly });
    box.addEventListener("change", () => write(() => items.update(r.id, { done: box.checked })));
    const del = el("button", { type: "button", textContent: "×", title: "Remove", disabled: readOnly });
    del.setAttribute("aria-label", "Remove " + r.label);
    del.addEventListener("click", () => write(() => items.remove(r.id)));
    return el("li", { className: r.done ? "done" : "" }, el("label", {}, box, el("span", { textContent: r.label })), del);
  }));

  const input = el("input", { placeholder: "Add an item", ariaLabel: "New item" });
  const form = el("form", {}, input, el("button", { type: "submit", textContent: "Add" }));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const label = input.value.trim();
    if (label) write(() => items.insert({ label, done: false }));
  });

  const hadFocus = document.activeElement?.ariaLabel === "New item";
  root.replaceChildren(el("div", { className: "checklist" + (embedded ? "" : " full") + (readOnly ? " readonly" : "") },
    embedded ? null : el("h1", { textContent: quire.page.title || "Checklist" }),
    el("p", { className: "count", textContent: `${packed} of ${rows.length} done` }),
    list,
    form,
  ));
  if (hadFocus) form.querySelector("input").focus();
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.quire === 1 && m.type === "mode") { readOnly = !!m.readOnly; render(); }
});

await quire.ready;
await render();
items.subscribe(render);
