import { useEffect, useState } from "react";

const books = window.quire.store.table("books");
const STATUSES = ["Next", "Reading", "Finished"];
const STARTERS = [
  { title: "Middlemarch", author: "George Eliot", status: "Reading" },
  { title: "The Peregrine", author: "J. A. Baker", status: "Next" },
  { title: "Invisible Cities", author: "Italo Calvino", status: "Finished" },
];

export default function App() {
  const [rows, setRows] = useState(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");

  useEffect(() => {
    const load = () => books.all().then(setRows);
    (async () => {
      await window.quire.ready;
      // First visit: a few books so there's something to look at.
      if (!(await window.quire.kv.get("seeded"))) {
        for (const b of STARTERS) await books.insert(b);
        await window.quire.kv.set("seeded", true);
      }
      load();
    })();
    return books.subscribe(load);
  }, []);

  const add = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    await books.insert({ title: title.trim(), author: author.trim(), status: "Next" });
    setTitle("");
    setAuthor("");
  };

  const cycle = (b) => books.update(b.id, { status: STATUSES[(STATUSES.indexOf(b.status) + 1) % STATUSES.length] });

  if (!rows) return null;
  return (
    <div className="rl">
      {STATUSES.map((s) => {
        const group = rows.filter((b) => b.status === s);
        return (
          <section key={s} className="rl-group">
            <h3>
              {s} <span>{group.length}</span>
            </h3>
            {group.length ? (
              <ul>
                {group.map((b) => (
                  <li key={b.id}>
                    <button type="button" className="rl-status" data-status={s} onClick={() => cycle(b)} title="Move to the next list">
                      {s}
                    </button>
                    <span className="rl-title">{b.title}</span>
                    {b.author ? <span className="rl-author">{b.author}</span> : null}
                    <button type="button" className="rl-remove" aria-label={"Remove " + b.title} onClick={() => books.remove(b.id)}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rl-empty">Nothing here.</p>
            )}
          </section>
        );
      })}
      <form className="rl-add" onSubmit={add}>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="Author" value={author} onChange={(e) => setAuthor(e.target.value)} />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}
