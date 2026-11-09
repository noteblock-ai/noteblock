// Per-page, per-user SQLite store: <pageDir>/data/<user>.sqlite
// One node:sqlite DatabaseSync per file, cached for the life of the process, WAL mode.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getRandomValues } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 10 chars of [a-z0-9]. */
export function newId(len = 10) {
  const bytes = getRandomValues(new Uint8Array(len * 2));
  let out = '';
  for (const b of bytes) {
    if (b >= 252) continue; // 252 = 36*7, keeps it unbiased
    out += ALPHABET[b % 36];
    if (out.length === len) return out;
  }
  return out.length === len ? out : out + newId(len - out.length);
}

/** @type {Map<string, Store>} */
const cache = new Map();

const META = new Set(['id', '_created', '_updated']);

function strip(obj) {
  const data = {};
  for (const [k, v] of Object.entries(obj || {})) if (!META.has(k)) data[k] = v;
  return data;
}

function toRow(r) {
  if (!r) return null;
  return { ...JSON.parse(r.data), id: r.id, _created: Number(r.created), _updated: Number(r.updated) };
}

function checkTable(table) {
  if (typeof table !== 'string' || !table) throw new Error('table must be a non-empty string');
}

export class Store {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=2000');
    db.exec(`CREATE TABLE IF NOT EXISTS rows (
      tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tbl, id))`);
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
    this.db = db;
    this.q = {
      all: db.prepare('SELECT * FROM rows WHERE tbl = ? ORDER BY created, rowid'),
      get: db.prepare('SELECT * FROM rows WHERE tbl = ? AND id = ?'),
      insert: db.prepare('INSERT INTO rows (tbl, id, data, created, updated) VALUES (?, ?, ?, ?, ?)'),
      update: db.prepare('UPDATE rows SET data = ?, updated = ? WHERE tbl = ? AND id = ?'),
      remove: db.prepare('DELETE FROM rows WHERE tbl = ? AND id = ?'),
      tables: db.prepare('SELECT DISTINCT tbl FROM rows ORDER BY tbl'),
      kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'),
      kvSet: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  all(table) {
    checkTable(table);
    return this.q.all.all(table).map(toRow);
  }

  get(table, id) {
    checkTable(table);
    return toRow(this.q.get.get(table, String(id)));
  }

  insert(table, obj = {}) {
    checkTable(table);
    const id = obj.id != null && obj.id !== '' ? String(obj.id) : newId();
    const now = Date.now();
    this.q.insert.run(table, id, JSON.stringify(strip(obj)), now, now);
    return this.get(table, id);
  }

  update(table, id, patch = {}) {
    checkTable(table);
    const cur = this.q.get.get(table, String(id));
    if (!cur) throw new Error(`No row ${id} in ${table}`);
    const data = { ...JSON.parse(cur.data), ...strip(patch) };
    this.q.update.run(JSON.stringify(data), Date.now(), table, String(id));
    return this.get(table, id);
  }

  remove(table, id) {
    checkTable(table);
    this.q.remove.run(table, String(id));
    return true;
  }

  kvGet(key) {
    const r = this.q.kvGet.get(String(key));
    return r ? JSON.parse(r.value) : null;
  }

  kvSet(key, value) {
    this.q.kvSet.run(String(key), JSON.stringify(value === undefined ? null : value));
    return true;
  }

  tables() {
    return this.q.tables.all().map((r) => r.tbl);
  }

  close() {
    cache.delete(this.file);
    try { this.db.close(); } catch {}
  }
}

/**
 * @param {string} pageDir absolute page directory
 * @param {string} user    already-sanitised user name
 * @returns {Store}
 */
export function openStore(pageDir, user) {
  const dir = join(resolve(pageDir), 'data');
  const file = join(dir, `${user}.sqlite`);
  let store = cache.get(file);
  if (store) return store;
  mkdirSync(dir, { recursive: true });
  store = new Store(file);
  cache.set(file, store);
  return store;
}

/** Close every cached handle (tests, shutdown). */
export function closeAllStores() {
  for (const s of [...cache.values()]) s.close();
}

/** Close the cached handles of every store file under `dir` (a page or folder about to move). */
export function closeStoresUnder(dir) {
  const base = resolve(dir) + sep;
  for (const s of [...cache.values()]) if (s.file.startsWith(base)) s.close();
}

const cell = (v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === "bigint" ? String(v) : v);
const quoteId = (name) => '"' + String(name).replace(/"/g, '""') + '"';

/**
 * Read-only look into any SQLite file, for the app's database viewer.
 * Quire store files also list their store tables (rows grouped by `tbl`, data spread into
 * columns); `table` names one of those as "store:<name>", or a raw SQLite table.
 * @returns {{store: {name, count}[], tables: {name, count}[], table: string|null,
 *            columns: string[], rows: any[][], total: number, offset: number}}
 */
export function inspectDb(file, { table = null, offset = 0, limit = 200 } = {}) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const tables = names.map((name) => ({ name, count: Number(db.prepare(`SELECT count(*) AS n FROM ${quoteId(name)}`).get().n) }));
    const isStore = names.includes("rows") && names.includes("kv");
    const store = isStore
      ? db.prepare("SELECT tbl AS name, count(*) AS n FROM rows GROUP BY tbl ORDER BY tbl").all().map((r) => ({ name: r.name, count: Number(r.n) }))
      : [];
    const pick = table || (store[0] ? "store:" + store[0].name : tables[0]?.name) || null;
    const out = { store, tables, table: pick, columns: [], rows: [], total: 0, offset };
    if (!pick) return out;

    if (pick.startsWith("store:") && isStore) {
      const tbl = pick.slice(6);
      out.total = Number(db.prepare("SELECT count(*) AS n FROM rows WHERE tbl = ?").get(tbl).n);
      const raw = db.prepare("SELECT id, data, created, updated FROM rows WHERE tbl = ? ORDER BY created LIMIT ? OFFSET ?").all(tbl, limit, offset);
      const objs = raw.map((r) => {
        let data = {};
        try {
          data = JSON.parse(r.data) || {};
        } catch {}
        return { r, data };
      });
      const keys = [];
      for (const { data } of objs) for (const k of Object.keys(data)) if (k !== "id" && !keys.includes(k)) keys.push(k);
      out.columns = ["id", ...keys, "_created", "_updated"];
      out.rows = objs.map(({ r, data }) => [
        r.id,
        ...keys.map((k) => (data[k] !== null && typeof data[k] === "object" ? JSON.stringify(data[k]) : data[k] ?? null)),
        new Date(Number(r.created)).toISOString(),
        new Date(Number(r.updated)).toISOString(),
      ]);
      return out;
    }

    if (!names.includes(pick)) throw new Error(`No table: ${pick}`);
    out.columns = db.prepare(`PRAGMA table_info(${quoteId(pick)})`).all().map((c) => c.name);
    out.total = tables.find((t) => t.name === pick).count;
    out.rows = db
      .prepare(`SELECT * FROM ${quoteId(pick)} LIMIT ? OFFSET ?`)
      .all(limit, offset)
      .map((r) => out.columns.map((c) => cell(r[c])));
    return out;
  } finally {
    db.close();
  }
}
