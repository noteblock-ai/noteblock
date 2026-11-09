import { useCallback, useEffect, useState } from "react";
import { DbIcon } from "./icons.jsx";

const PAGE = 200;

function show(v) {
  if (v === null || v === undefined) return <span className="db-null">null</span>;
  return String(v);
}

/** Read-only table browser for a SQLite file in a page (Quire store tables first). */
export default function SqliteView({ api, page, file }) {
  const [table, setTable] = useState(null);
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setRes(await api.inspectDb(page, file, { table, offset, limit: PAGE }));
      setError("");
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [api, page, file, table, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const pick = (t) => {
    setTable(t);
    setOffset(0);
  };

  const current = res?.table;
  const Item = ({ id, name, count }) => (
    <button type="button" className="db-table" aria-current={current === id ? "page" : undefined} onClick={() => pick(id)}>
      <span className="db-table-name">{name}</span>
      <span className="db-count">{count}</span>
    </button>
  );

  return (
    <div className="db-view">
      <nav className="db-tables" aria-label="Tables">
        {res?.store.length ? (
          <>
            <div className="db-group">Store tables</div>
            {res.store.map((t) => (
              <Item key={"s" + t.name} id={"store:" + t.name} name={t.name} count={t.count} />
            ))}
          </>
        ) : null}
        <div className="db-group">SQLite tables</div>
        {(res?.tables || []).map((t) => (
          <Item key={"t" + t.name} id={t.name} name={t.name} count={t.count} />
        ))}
      </nav>
      <section className="db-main" aria-label={current || file}>
        <div className="source-file">
          <DbIcon size={13} />
          <span>{file}</span>
          {error ? <span className="source-err" role="alert">{error}</span> : null}
          <span className="db-spacer" />
          {res && res.total > PAGE ? (
            <span className="db-pager">
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                ‹
              </button>
              {offset + 1}–{Math.min(offset + PAGE, res.total)} of {res.total}
              <button type="button" disabled={offset + PAGE >= res.total} onClick={() => setOffset(offset + PAGE)}>
                ›
              </button>
            </span>
          ) : res ? (
            <span>{res.total} rows</span>
          ) : null}
          <button type="button" className="db-refresh" onClick={load}>
            Refresh
          </button>
        </div>
        <div className="db-grid-wrap">
          {res && res.columns.length ? (
            <table className="db-grid">
              <thead>
                <tr>
                  {res.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {res.rows.map((row, i) => (
                  <tr key={offset + i}>
                    {row.map((v, j) => (
                      <td key={j} title={v == null ? "" : String(v)}>
                        {show(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : res ? (
            <p className="file-note">No tables.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
