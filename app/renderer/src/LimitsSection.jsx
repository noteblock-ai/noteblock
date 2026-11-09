// Settings → Activity & limits, the lower half: every limit from limits.mjs (quire:limitsSchema),
// in two groups, each saved through quire:setLimits as soon as it changes. A number that 0 turns
// off reads "Off" at 0. A row's error replaces its help line, so nothing moves.
import { useEffect, useState } from "react";

const PAGES = ["unresponsiveSeconds", "autoReloadCrashed", "autoReloadLimit", "errorBadge"];

/** Per limit: help line, unit after the field, stepper step, and the limit it depends on. */
const META = {
  unresponsiveSeconds: { help: "A page that stops responding this long shows a bar with Reload.", unit: "s" },
  autoReloadCrashed: { help: "Otherwise a crashed page waits for you to reload it." },
  autoReloadLimit: { help: "After that it waits for you, so a page that crashes on load can't loop.", unit: "crashes", needs: "autoReloadCrashed" },
  errorBadge: { help: "A count of the page's uncaught errors and console errors." },
  idleMinutes: { help: "A stopped backend starts again the next time its page is used.", unit: "min", step: 5 },
  maxRunning: { help: "Starting one more stops the least recently used.", unit: "backends" },
  maxProcesses: { help: "Over this, the backend and everything it started is killed at once.", unit: "processes", step: 8 },
  maxMemoryMB: { help: "All of a backend's processes together.", unit: "MB", step: 128 },
  cpuPercent: { help: "100% is one full core.", unit: "%", step: 10 },
  cpuSeconds: { help: "A backend over the CPU limit this long is stopped.", unit: "s", step: 5, needs: "cpuPercent" },
  crashLimit: { help: "Then it stays crashed until you restart it.", unit: "crashes" },
  crashWindowMinutes: { help: "Crashes longer ago than this don't count.", unit: "min", needs: "crashLimit" },
  stopGraceSeconds: { help: "Time to exit cleanly after being asked to, before it's killed.", unit: "s" },
  checkSeconds: { help: "How often memory, CPU and processes are measured.", unit: "s" },
};

const labelOf = (l) => l.label.replace(/\s*\(.*\)$/, "");
const fmt = (n) => String(Math.round(n * 100) / 100);
const offable = (l) => l.kind === "number" && l.min === 0;
const isDefault = (l) => l.value === l.default;

function NumberField({ limit, disabled, onSave }) {
  const meta = META[limit.name] || {};
  const step = meta.step || 1;
  const [draft, setDraft] = useState(null); // text while focused, null otherwise
  const off = offable(limit) && limit.value === 0;
  const shown = draft ?? (off ? "Off" : fmt(limit.value));

  const commit = (text) => {
    setDraft(null);
    const t = String(text).trim().toLowerCase();
    if (t === "" || t === (off ? "off" : fmt(limit.value))) return;
    const n = t === "off" ? 0 : Number(t);
    onSave(Number.isFinite(n) ? n : t);
  };
  const bump = (dir) => {
    const v = limit.value;
    // To the next multiple of the step up or down (Off → one step).
    let next = dir > 0 ? Math.floor(v / step) * step + step : Math.ceil(v / step) * step - step;
    next = Math.max(limit.min, Math.min(limit.max, next));
    if (next !== v) onSave(next);
  };

  return (
    <div className="limit-number">
      <div className="editor-stepper" role="group" aria-label={labelOf(limit)}>
        <button type="button" className="settings-button" aria-label="Less" disabled={disabled || limit.value <= limit.min} onClick={() => bump(-1)}>
          −
        </button>
        <input
          className={"settings-input limit-input" + (off && draft == null ? " is-off" : "")}
          inputMode="decimal"
          aria-label={labelOf(limit)}
          disabled={disabled}
          value={shown}
          onFocus={(e) => {
            setDraft(off ? "0" : fmt(limit.value));
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(off ? "0" : fmt(limit.value));
              requestAnimationFrame(() => e.target.blur());
            }
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              setDraft(null);
              bump(e.key === "ArrowUp" ? 1 : -1);
            }
          }}
        />
        <button type="button" className="settings-button" aria-label="More" disabled={disabled || limit.value >= limit.max} onClick={() => bump(1)}>
          +
        </button>
      </div>
      <span className="limit-unit">{meta.unit || ""}</span>
    </div>
  );
}

function LimitRow({ limit, all, error, onSave }) {
  const meta = META[limit.name] || {};
  const parent = meta.needs && all.find((l) => l.name === meta.needs);
  const disabled = !!parent && (parent.kind === "boolean" ? !parent.value : parent.value === 0);
  const sub = error || meta.help || "";
  const id = "limit-" + limit.name;
  return (
    <div data-setting={"limits." + limit.name} className={"editor-row limit-row" + (meta.needs ? " is-dependent" : "") + (disabled ? " is-disabled" : "")}>
      <label className="editor-label limit-label" htmlFor={limit.kind === "boolean" ? id : undefined}>
        <span>{labelOf(limit)}</span>
        <span className={"editor-sub limit-sub" + (error ? " is-error" : "")} role={error ? "alert" : undefined} title={sub}>
          {sub}
        </span>
      </label>
      {limit.kind === "boolean" ? (
        <div className="limit-check">
          <input id={id} type="checkbox" checked={!!limit.value} disabled={disabled} onChange={(e) => onSave(e.target.checked)} />
        </div>
      ) : (
        <NumberField limit={limit} disabled={disabled} onSave={onSave} />
      )}
    </div>
  );
}

export default function LimitsSection({ api, onChanged }) {
  const [schema, setSchema] = useState(null);
  const [errors, setErrors] = useState({}); // name → message
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let alive = true;
    api.limitsSchema().then(
      (s) => alive && setSchema(s),
      (e) => alive && setLoadError(String(e?.message || e)),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const save = async (name, value) => {
    const before = schema;
    if (typeof value === "string") {
      setErrors((x) => ({ ...x, [name]: "Enter a number" + (offable(schema.find((l) => l.name === name)) ? " (0 turns it off)" : "") }));
      return;
    }
    setSchema((s) => s.map((l) => (l.name === name ? { ...l, value } : l)));
    try {
      await api.setLimits({ [name]: value });
      setErrors((x) => ({ ...x, [name]: "" }));
      setSchema(await api.limitsSchema());
      onChanged?.();
    } catch (e) {
      setSchema(before);
      setErrors((x) => ({ ...x, [name]: String(e?.message || e) }));
    }
  };

  const reset = async () => {
    try {
      await api.resetLimits();
      setErrors({});
      setSchema(await api.limitsSchema());
      onChanged?.();
    } catch (e) {
      setLoadError(String(e?.message || e));
    }
  };

  if (!schema) return loadError ? <p className="settings-error">{loadError}</p> : null;
  const groups = [
    ["Pages", schema.filter((l) => PAGES.includes(l.name))],
    ["Backends", schema.filter((l) => !PAGES.includes(l.name))],
  ];
  return (
    <section className="limits" aria-labelledby="limits-head">
      <div className="activity-section-head limits-head" data-setting="activity.limits">
        <span className="vault-field-label" id="limits-head">
          Limits
        </span>
        <button type="button" className="settings-button" disabled={schema.every(isDefault)} onClick={reset}>
          Reset to defaults
        </button>
      </div>
      {loadError ? <p className="settings-error">{loadError}</p> : null}
      {groups.map(([title, rows]) => (
        <div key={title} className="limits-group">
          <div className="limits-group-title">{title}</div>
          <div className="editor-list">
            {rows.map((l) => (
              <LimitRow key={l.name} limit={l} all={schema} error={errors[l.name]} onSave={(v) => save(l.name, v)} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
