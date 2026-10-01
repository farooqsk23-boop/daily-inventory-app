import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, type Item, type Settings } from "../shared/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR ?? join(here, "..", "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH ?? join(DATA_DIR, "stockroom.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  supplier TEXT,
  pack_size REAL,
  unit TEXT NOT NULL DEFAULT 'carton',
  min_level REAL,
  max_holding REAL,
  avg_daily REAL,
  lead_days INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS count_sessions (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  photos TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counts (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES count_sessions(id),
  date TEXT NOT NULL,
  sku TEXT NOT NULL REFERENCES items(sku) ON UPDATE CASCADE,
  qty REAL NOT NULL,
  ocr_qty REAL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS counts_sku ON counts(sku, created_at);
CREATE TABLE IF NOT EXISTS delivery_sessions (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  supplier TEXT,
  reference TEXT,
  photos TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES delivery_sessions(id),
  date TEXT NOT NULL,
  sku TEXT NOT NULL REFERENCES items(sku) ON UPDATE CASCADE,
  qty REAL NOT NULL,
  ocr_qty REAL,
  source_name TEXT,
  ordered_qty REAL,
  shortage REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_sku ON deliveries(sku, created_at);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  order_date TEXT NOT NULL,
  expected_delivery TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL REFERENCES items(sku) ON UPDATE CASCADE,
  qty REAL NOT NULL,
  received REAL NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  expected TEXT
);
CREATE TABLE IF NOT EXISTS forecast (
  sku TEXT NOT NULL,
  date TEXT NOT NULL,
  qty REAL NOT NULL,
  import_id INTEGER,
  PRIMARY KEY (sku, date)
);
CREATE TABLE IF NOT EXISTS forecast_imports (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  unit TEXT,
  from_date TEXT,
  to_date TEXT,
  rows INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mappings (
  source_key TEXT NOT NULL,
  context TEXT NOT NULL,
  source_name TEXT NOT NULL,
  sku TEXT,
  confidence REAL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_key, context)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  sku TEXT,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reminders_sent (key TEXT PRIMARY KEY);
`);

export const nowIso = () => new Date().toISOString();

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

type Row = Record<string, unknown>;
export const all = <T = Row>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as T[];
export const get = <T = Row>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T | undefined;
export const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));

// ---------- settings ----------

export function getSettings(): Settings {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM settings");
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) s[r.key] = JSON.parse(r.value);
  return s as unknown as Settings;
}

export function getSecret(key: string): string | null {
  const r = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `secret:${key}`);
  return r ? JSON.parse(r.value) : null;
}

export function setSecret(key: string, value: string) {
  run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", `secret:${key}`, JSON.stringify(value));
}

// ---------- items ----------

interface ItemRow {
  sku: string;
  name: string;
  supplier: string | null;
  pack_size: number | null;
  unit: string;
  min_level: number | null;
  max_holding: number | null;
  avg_daily: number | null;
  lead_days: number | null;
  active: number;
  sort_order: number;
}

export function toItem(r: ItemRow): Item {
  return {
    sku: r.sku,
    name: r.name,
    supplier: r.supplier,
    packSize: r.pack_size,
    unit: r.unit === "piece" ? "piece" : "carton",
    minLevel: r.min_level,
    maxHolding: r.max_holding,
    avgDaily: r.avg_daily,
    leadDays: r.lead_days,
    active: !!r.active,
    sortOrder: r.sort_order,
  };
}

export function getItems(includeInactive = true): Item[] {
  return all<ItemRow>(
    `SELECT * FROM items ${includeInactive ? "" : "WHERE active = 1"} ORDER BY sort_order, sku`,
  ).map(toItem);
}

export function getItem(sku: string): Item | null {
  const r = get<ItemRow>("SELECT * FROM items WHERE sku = ?", sku);
  return r ? toItem(r) : null;
}

export interface MasterRow {
  sku: string;
  name: string;
  supplier: string | null;
  avgDaily: number | null;
  maxHolding: number | null;
  packSize: number | null;
}

/** Insert or update master rows. Existing per-item settings (min level, unit...) are kept. */
export function upsertMaster(rows: MasterRow[], actor: string): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  const maxOrder = get<{ m: number | null }>("SELECT MAX(sort_order) m FROM items")?.m ?? -1;
  tx(() => {
    rows.forEach((r, i) => {
      const cur = getItem(r.sku);
      if (!cur) {
        run(
          `INSERT INTO items (sku, name, supplier, pack_size, unit, max_holding, avg_daily, sort_order)
           VALUES (?, ?, ?, ?, 'carton', ?, ?, ?)`,
          r.sku, r.name, r.supplier, r.packSize, r.maxHolding, r.avgDaily, maxOrder + 1 + i,
        );
        audit({ actor, action: "create", entity: "item", sku: r.sku, newValue: r.name, note: "Master inventory import" });
        added++;
      } else {
        const changes: [string, string, unknown, unknown][] = [
          ["name", "name", cur.name, r.name],
          ["supplier", "supplier", cur.supplier, r.supplier],
          ["pack_size", "packSize", cur.packSize, r.packSize ?? cur.packSize],
          ["max_holding", "maxHolding", cur.maxHolding, r.maxHolding ?? cur.maxHolding],
          ["avg_daily", "avgDaily", cur.avgDaily, r.avgDaily ?? cur.avgDaily],
        ];
        let any = false;
        for (const [col, field, oldV, newV] of changes) {
          if (oldV !== newV) {
            run(`UPDATE items SET ${col} = ? WHERE sku = ?`, newV, r.sku);
            audit({ actor, action: "update", entity: "item", sku: r.sku, field, oldValue: oldV, newValue: newV, note: "Master inventory import" });
            any = true;
          }
        }
        if (any) updated++;
      }
    });
  });
  return { added, updated };
}

// ---------- audit ----------

export function audit(a: {
  actor: string;
  action: string;
  entity: string;
  sku?: string | null;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  note?: string | null;
}) {
  const fmt = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v));
  run(
    `INSERT INTO audit (ts, actor, action, entity, sku, field, old_value, new_value, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nowIso(), a.actor, a.action, a.entity, a.sku ?? null, a.field ?? null, fmt(a.oldValue), fmt(a.newValue), a.note ?? null,
  );
}

// ---------- seed ----------

export function seedIfEmpty() {
  const n = get<{ n: number }>("SELECT COUNT(*) n FROM items")?.n ?? 0;
  if (n > 0) return;
  const seed = JSON.parse(readFileSync(join(here, "seed", "master-inventory.json"), "utf8")) as MasterRow[];
  upsertMaster(seed, "System (initial master inventory)");
}
