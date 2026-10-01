import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { addDays, deliveryDateFor, effectiveOrderDate, isWorkingDay, type ISODate } from "../shared/calendar.ts";
import { mappingKey, matchName, type MatchResult } from "../shared/matching.ts";
import { calendarFor, type ItemPlan } from "../shared/ordering.ts";
import { DEFAULT_SETTINGS, type Item, type Settings } from "../shared/types.ts";
import {
  all,
  audit,
  get,
  getItem,
  getItems,
  getSettings,
  nowIso,
  run,
  tx,
  UPLOAD_DIR,
  upsertMaster,
} from "./db.ts";
import { buildWorkbook, parseMasterWorkbook, parseUsageWorkbook } from "./excel.ts";
import { OcrError, ocrAvailable, ocrSource, readCountSheet, readDeliveryNote, removeApiKey, saveApiKey, type ImageInput } from "./ocr.ts";
import { notifyAll, saveSubscription, removeSubscription, subscriptionCount, vapidPublicKey, orderReminderMessage } from "./push.ts";
import { currentPlan, discrepancyFor, engineInput, openOrderLines, today } from "./state.ts";

export const api = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 12 } });

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

function actor(via?: string): string {
  const name = getSettings().controllerName || "Controller";
  return via ? `${name} (${via})` : name;
}

function bad(res: Response, message: string, code = 400, extra: object = {}) {
  res.status(code).json({ error: message, ...extra });
}

// ---------- health / dashboard ----------

api.get("/health", (_req, res) => {
  res.json({ ok: true, ocr: ocrAvailable(), ocrSource: ocrSource(), pushSubscribers: subscriptionCount(), auth: !!process.env.APP_PIN });
});

// ---------- AI scan key ----------

api.put(
  "/ocr/key",
  wrap(async (req, res) => {
    try {
      await saveApiKey(String(req.body?.key ?? ""));
    } catch (e) {
      return ocrFail(res, e);
    }
    audit({ actor: actor(), action: "update", entity: "setting", field: "AI scan key", newValue: "set" });
    res.json({ ok: true });
  }),
);

api.delete(
  "/ocr/key",
  wrap((_req, res) => {
    removeApiKey();
    audit({ actor: actor(), action: "update", entity: "setting", field: "AI scan key", newValue: "removed" });
    res.json({ ok: true, ocr: ocrAvailable() });
  }),
);

api.get(
  "/dashboard",
  wrap((_req, res) => {
    const plan = currentPlan();
    const lastCount = get<{ date: string; created_at: string }>("SELECT date, created_at FROM count_sessions ORDER BY created_at DESC LIMIT 1");
    const lastDelivery = get<{ date: string }>("SELECT date FROM delivery_sessions ORDER BY created_at DESC LIMIT 1");
    const lastImport = get<{ created_at: string; from_date: string; to_date: string }>(
      "SELECT created_at, from_date, to_date FROM forecast_imports ORDER BY id DESC LIMIT 1",
    );
    const lastOrder = get<{ order_date: string; placed_at: string }>("SELECT order_date, placed_at FROM orders ORDER BY id DESC LIMIT 1");
    const unmatched = get<{ n: number }>("SELECT COUNT(*) n FROM mappings WHERE status = 'unmatched'")?.n ?? 0;
    const overdue = openOrderLines().filter((l) => l.expected_delivery < plan.today).length;
    res.json({
      ...plan,
      isWorkingDay: isWorkingDay(plan.today, plan.settings),
      lastCount: lastCount ?? null,
      lastDelivery: lastDelivery ?? null,
      lastImport: lastImport ?? null,
      lastOrder: lastOrder ?? null,
      unmatchedMappings: unmatched,
      overdueDeliveries: overdue,
      ocr: ocrAvailable(),
    });
  }),
);

// ---------- settings ----------

api.get("/settings", (_req, res) => res.json(getSettings()));

api.put(
  "/settings",
  wrap((req, res) => {
    const cur = getSettings();
    const body = req.body as Partial<Settings>;
    const next: Settings = { ...cur };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (!(key in body)) continue;
      const v = body[key];
      const def = DEFAULT_SETTINGS[key];
      if (Array.isArray(def) ? !Array.isArray(v) : typeof v !== typeof def) return bad(res, `Invalid value for ${key}`);
      if ((key === "cutoff" || key === "reminderTimes") && ![v].flat().every((t) => /^\d{1,2}:\d{2}$/.test(String(t))))
        return bad(res, `Times must look like 12:30`);
      if (key === "timeZone") {
        try {
          new Intl.DateTimeFormat("en", { timeZone: String(v) });
        } catch {
          return bad(res, "Unknown time zone");
        }
      }
      if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) return bad(res, `Invalid value for ${key}`);
      (next as unknown as Record<string, unknown>)[key] = v;
    }
    tx(() => {
      for (const key of Object.keys(next) as (keyof Settings)[]) {
        if (JSON.stringify(next[key]) === JSON.stringify(cur[key])) continue;
        run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, JSON.stringify(next[key]));
        audit({ actor: actor(), action: "update", entity: "setting", field: key, oldValue: cur[key], newValue: next[key] });
      }
    });
    res.json(getSettings());
  }),
);

// ---------- items ----------

api.get("/items", (_req, res) => res.json(getItems()));

const ITEM_FIELDS: Record<string, { col: string; type: "number" | "string" | "bool" | "unit" }> = {
  name: { col: "name", type: "string" },
  supplier: { col: "supplier", type: "string" },
  packSize: { col: "pack_size", type: "number" },
  unit: { col: "unit", type: "unit" },
  minLevel: { col: "min_level", type: "number" },
  maxHolding: { col: "max_holding", type: "number" },
  avgDaily: { col: "avg_daily", type: "number" },
  leadDays: { col: "lead_days", type: "number" },
  active: { col: "active", type: "bool" },
  sortOrder: { col: "sort_order", type: "number" },
};

function cleanItemValue(type: string, v: unknown): unknown {
  if (type === "number") {
    if (v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error("must be a positive number");
    return n;
  }
  if (type === "bool") return v ? 1 : 0;
  if (type === "unit") {
    if (v !== "carton" && v !== "piece") throw new Error("must be carton or piece");
    return v;
  }
  return v == null ? null : String(v).trim();
}

api.put(
  "/items/:sku",
  wrap((req, res) => {
    const item = getItem(String(req.params.sku));
    if (!item) return bad(res, "Unknown SKU", 404);
    try {
      tx(() => {
        for (const [field, val] of Object.entries(req.body as Record<string, unknown>)) {
          const f = ITEM_FIELDS[field];
          if (!f) continue;
          const v = cleanItemValue(f.type, val);
          const old = (item as unknown as Record<string, unknown>)[field];
          const oldCmp = f.type === "bool" ? (old ? 1 : 0) : old;
          if (oldCmp === v) continue;
          if (f.col === "name" && !v) throw new Error("Name is required");
          run(`UPDATE items SET ${f.col} = ? WHERE sku = ?`, v as never, item.sku);
          audit({ actor: actor(), action: "update", entity: "item", sku: item.sku, field, oldValue: old, newValue: v });
        }
      });
    } catch (e) {
      return bad(res, (e as Error).message);
    }
    res.json(getItem(item.sku));
  }),
);

api.post(
  "/items",
  wrap((req, res) => {
    const { sku, name, supplier, packSize, maxHolding, avgDaily } = req.body ?? {};
    if (!sku || !name) return bad(res, "SKU and name are required");
    if (getItem(String(sku).trim())) return bad(res, "That SKU already exists");
    upsertMaster(
      [{ sku: String(sku).trim(), name: String(name).trim(), supplier: supplier || null, packSize: packSize ?? null, maxHolding: maxHolding ?? null, avgDaily: avgDaily ?? null }],
      actor(),
    );
    res.json(getItem(String(sku).trim()));
  }),
);

api.post(
  "/items/import",
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) return bad(res, "No file uploaded");
    try {
      const rows = await parseMasterWorkbook(req.file.buffer);
      if (!rows.length) return bad(res, "No items found in that file");
      res.json(upsertMaster(rows, actor("master inventory import")));
    } catch (e) {
      bad(res, (e as Error).message);
    }
  }),
);

api.get(
  "/items/:sku/history",
  wrap((req, res) => {
    const sku = String(req.params.sku);
    const item = getItem(sku);
    if (!item) return bad(res, "Unknown SKU", 404);
    const since = addDays(today().date, -Number(req.query.days ?? 60));
    const counts = all("SELECT date, qty, ocr_qty, source, created_at FROM counts WHERE sku = ? AND date >= ? ORDER BY created_at", sku, since);
    const deliveries = all(
      "SELECT date, qty, ordered_qty, shortage, created_at FROM deliveries WHERE sku = ? AND date >= ? ORDER BY created_at",
      sku, since,
    );
    const orders = all(
      `SELECT o.id, o.order_date, COALESCE(l.expected, o.expected_delivery) expected, l.qty, l.received, l.closed
       FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.sku = ? AND o.order_date >= ? ORDER BY o.order_date`,
      sku, since,
    );
    const forecast = all("SELECT date, qty FROM forecast WHERE sku = ? AND date >= ? ORDER BY date", sku, since);
    const auditRows = all("SELECT * FROM audit WHERE sku = ? ORDER BY id DESC LIMIT 100", sku);
    const plan = currentPlan().plans.find((p) => p.sku === sku) ?? null;
    res.json({ item, plan, counts, deliveries, orders, forecast, audit: auditRows });
  }),
);

// ---------- uploads ----------

function saveImages(files: Express.Multer.File[]): { ids: string[]; images: ImageInput[] } {
  const ids: string[] = [];
  const images: ImageInput[] = [];
  for (const f of files) {
    const mediaType = (["image/jpeg", "image/png", "image/webp"].includes(f.mimetype) ? f.mimetype : "image/jpeg") as ImageInput["mediaType"];
    const id = `${randomUUID()}.${mediaType.split("/")[1]}`;
    writeFileSync(join(UPLOAD_DIR, id), f.buffer);
    ids.push(id);
    images.push({ data: f.buffer, mediaType });
  }
  return { ids, images };
}

api.get("/uploads/:id", (req, res) => {
  const id = String(req.params.id);
  if (!/^[\w-]+\.(jpeg|png|webp)$/.test(id)) return bad(res, "Bad id");
  const p = join(UPLOAD_DIR, id);
  if (!existsSync(p)) return bad(res, "Not found", 404);
  res.type(id.split(".").pop()!).send(readFileSync(p));
});

function ocrFail(res: Response, e: unknown) {
  if (e instanceof OcrError) return bad(res, e.message, e.kind === "config" ? 503 : 422, { kind: e.kind });
  throw e;
}

// ---------- count ----------

function sheetRows() {
  return getItems(false).map((it, i) => ({ row: i + 1, sku: it.sku, name: it.name, unit: it.unit, packSize: it.packSize }));
}

api.get("/count/sheet", (_req, res) => res.json({ date: today().date, rows: sheetRows() }));

/** Previous count and expected stock per SKU, for the discrepancy column on the review screen. */
api.get(
  "/count/context",
  wrap((req, res) => {
    const date = String(req.query.date ?? today().date);
    const inp = engineInput();
    const out: Record<string, unknown> = {};
    for (const item of inp.items) {
      // Pass counted = 0 just to get `expected`; the client computes the gap live.
      const d = discrepancyFor(item, 0, date, inp);
      out[item.sku] = { prev: d.prev, expected: d.expected };
    }
    const s = inp.settings;
    res.json({ date, context: out, discrepancyPct: s.discrepancyPct, discrepancyMin: s.discrepancyMin });
  }),
);

api.post(
  "/count/ocr",
  upload.array("photos", 12),
  wrap(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) return bad(res, "Add at least one photo");
    const { ids, images } = saveImages(files);
    const rows = sheetRows();
    try {
      // One request per photo so a single bad photo can be retaken on its own.
      const results = await Promise.all(images.map((img) => readCountSheet([img], rows)));
      const merged = new Map<string, { sku: string; count: number | null; confidence: string; note: string; photo: number }>();
      const rank = { high: 3, medium: 2, low: 1 } as const;
      const known = new Set(rows.map((r) => r.sku.toUpperCase()));
      const bySkuRow = new Map(rows.map((r) => [r.row, r.sku]));
      results.forEach((r, photo) => {
        if (!r.quality.readable) return;
        for (const line of r.rows) {
          // Trust the printed SKU; fall back to the row number.
          const sku = known.has(line.sku.toUpperCase()) ? rows.find((x) => x.sku.toUpperCase() === line.sku.toUpperCase())!.sku : bySkuRow.get(line.row);
          if (!sku) continue;
          const cur = merged.get(sku);
          if (line.count == null && cur) continue;
          if (!cur || cur.count == null || rank[line.confidence] > rank[cur.confidence as keyof typeof rank]) {
            merged.set(sku, { sku, count: line.count, confidence: line.confidence, note: line.note, photo });
          }
        }
      });
      res.json({
        photos: ids,
        quality: results.map((r, i) => ({ photo: ids[i], readable: r.quality.readable, problem: r.quality.problem, rowsRead: r.rows.filter((x) => x.count != null).length })),
        lines: [...merged.values()],
      });
    } catch (e) {
      ocrFail(res, e);
    }
  }),
);

api.post(
  "/count/commit",
  wrap(async (req, res) => {
    const { date, photos, lines } = req.body as {
      date: ISODate;
      photos?: string[];
      lines: { sku: string; qty: number | null; ocrQty?: number | null }[];
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return bad(res, "Invalid date");
    const valid = (lines ?? []).filter((l) => l.qty != null && Number.isFinite(Number(l.qty)) && Number(l.qty) >= 0);
    if (!valid.length) return bad(res, "No counts to save");
    for (const l of valid) if (!getItem(l.sku)) return bad(res, `Unknown SKU ${l.sku}`);
    const ts = nowIso();
    const prevStock = engineInput().stock;
    tx(() => {
      const sid = Number(run("INSERT INTO count_sessions (date, photos, created_at) VALUES (?, ?, ?)", date, JSON.stringify(photos ?? []), ts).lastInsertRowid);
      for (const l of valid) {
        const qty = Number(l.qty);
        const ocrQty = l.ocrQty == null ? null : Number(l.ocrQty);
        const source = ocrQty == null ? "manual" : ocrQty === qty ? "ocr" : "ocr-corrected";
        run("INSERT INTO counts (session_id, date, sku, qty, ocr_qty, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", sid, date, l.sku, qty, ocrQty, source, ts);
        const who = source === "manual" ? actor("manual count") : source === "ocr" ? `OCR, confirmed by ${actor()}` : `${actor()} (corrected OCR ${ocrQty})`;
        audit({ actor: who, action: "count", entity: "stock", sku: l.sku, field: "stock", oldValue: prevStock[l.sku] ?? null, newValue: qty, note: `Physical count ${date}` });
      }
    });
    const plan = currentPlan();
    const counted = new Set(valid.map((l) => l.sku));
    const flagged = plan.plans.filter((p) => counted.has(p.sku) && (p.status === "low" || p.status === "critical"));
    if (flagged.length) {
      const crit = flagged.filter((p) => p.status === "critical");
      void notifyAll({
        title: crit.length ? `${crit.length} critical, ${flagged.length - crit.length} low after count` : `${flagged.length} items low after count`,
        body: flagged
          .slice(0, 5)
          .map((p) => `${p.status === "critical" ? "🔴" : "🟠"} ${p.name.slice(0, 30)}: ${p.stock}`)
          .join("\n"),
        url: "/#/",
        tag: "low-stock",
      });
    }
    res.json({ saved: valid.length, flagged: flagged.map(slimPlan), summary: plan.summary });
  }),
);

function slimPlan(p: ItemPlan) {
  return { sku: p.sku, name: p.name, stock: p.stock, status: p.status, statusReason: p.statusReason, orderQty: p.orderQty, daysOfCover: p.daysOfCover };
}

// ---------- mappings ----------

type Context = "usage" | "delivery";

function savedMapping(context: Context, sourceName: string) {
  return get<{ sku: string | null; status: string; confidence: number | null }>(
    "SELECT sku, status, confidence FROM mappings WHERE source_key = ? AND context = ?",
    mappingKey(sourceName),
    context,
  );
}

function saveMapping(context: Context, sourceName: string, sku: string | null, status: string, confidence: number | null, who: string) {
  const prev = savedMapping(context, sourceName);
  if (prev && prev.sku === sku && prev.status === status) return;
  run(
    "INSERT OR REPLACE INTO mappings (source_key, context, source_name, sku, confidence, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    mappingKey(sourceName), context, sourceName, sku, confidence, status, nowIso(),
  );
  audit({ actor: who, action: "mapping", entity: `mapping:${context}`, sku, field: sourceName, oldValue: prev ? `${prev.sku ?? "—"} (${prev.status})` : null, newValue: `${sku ?? "—"} (${status})` });
}

function resolve(context: Context, sourceName: string, code: string | null, items: Item[]): MatchResult & { saved: boolean; ignored: boolean } {
  const saved = savedMapping(context, sourceName);
  const candidates = items.map((i) => ({ sku: i.sku, name: i.name }));
  const fuzzy = matchName(`${code ?? ""} ${sourceName}`.trim(), candidates);
  if (saved && (saved.status === "confirmed" || saved.status === "ignored")) {
    return { ...fuzzy, sku: saved.sku, confidence: 1, level: saved.sku ? "exact" : "none", saved: true, ignored: saved.status === "ignored" };
  }
  return { ...fuzzy, saved: false, ignored: false };
}

api.get("/mappings", (_req, res) => {
  res.json(all("SELECT * FROM mappings ORDER BY CASE status WHEN 'unmatched' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END, context, source_name"));
});

api.get(
  "/mappings/suggest",
  wrap((req, res) => {
    const name = String(req.query.name ?? "");
    res.json(matchName(name, getItems().map((i) => ({ sku: i.sku, name: i.name }))));
  }),
);

api.put(
  "/mappings",
  wrap((req, res) => {
    const { context, sourceName, sku, status } = req.body as { context: Context; sourceName: string; sku: string | null; status: string };
    if (!["usage", "delivery"].includes(context) || !sourceName) return bad(res, "Invalid mapping");
    if (sku && !getItem(sku)) return bad(res, "Unknown SKU");
    const st = status === "ignored" ? "ignored" : sku ? "confirmed" : "unmatched";
    saveMapping(context, sourceName, sku || null, st, sku ? 1 : null, actor());
    res.json({ ok: true });
  }),
);

api.delete(
  "/mappings",
  wrap((req, res) => {
    const { context, sourceName } = req.body as { context: Context; sourceName: string };
    run("DELETE FROM mappings WHERE source_key = ? AND context = ?", mappingKey(sourceName), context);
    audit({ actor: actor(), action: "delete", entity: `mapping:${context}`, field: sourceName });
    res.json({ ok: true });
  }),
);

// ---------- usage forecast ----------

api.post(
  "/usage/parse",
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) return bad(res, "No file uploaded");
    let parsed;
    try {
      parsed = await parseUsageWorkbook(req.file.buffer, today().date);
    } catch (e) {
      return bad(res, (e as Error).message);
    }
    const items = getItems(false);
    const rows = parsed.rows.map((r) => ({ ...r, match: resolve("usage", r.sourceName, r.code, items) }));
    const mapped = new Set(rows.map((r) => r.match.sku).filter(Boolean));
    res.json({
      filename: req.file.originalname,
      sheet: parsed.sheet,
      layout: parsed.layout,
      from: parsed.from,
      to: parsed.to,
      rows,
      itemsWithoutUsage: items.filter((i) => !mapped.has(i.sku)).map((i) => ({ sku: i.sku, name: i.name })),
    });
  }),
);

api.post(
  "/usage/commit",
  wrap((req, res) => {
    const { filename, unit, rows } = req.body as {
      filename: string;
      unit: "piece" | "carton";
      rows: { sourceName: string; sku: string | null; ignore?: boolean; confirmed?: boolean; confidence?: number; days: Record<ISODate, number> }[];
    };
    if (!Array.isArray(rows)) return bad(res, "Nothing to import");
    const items = new Map(getItems().map((i) => [i.sku, i]));
    const totals = new Map<string, Record<ISODate, number>>();
    const warnings: string[] = [];
    const who = actor("usage import");
    tx(() => {
      for (const r of rows) {
        if (r.ignore) {
          saveMapping("usage", r.sourceName, null, "ignored", null, actor());
          continue;
        }
        if (!r.sku) {
          saveMapping("usage", r.sourceName, null, "unmatched", null, who);
          continue;
        }
        const item = items.get(r.sku);
        if (!item) continue;
        saveMapping("usage", r.sourceName, r.sku, r.confirmed ? "confirmed" : "auto", r.confidence ?? null, r.confirmed ? actor() : who);
        let factor = 1;
        if (unit === "piece" && item.unit === "carton") {
          if (item.packSize) factor = 1 / item.packSize;
          else warnings.push(`${item.sku} ${item.name}: no pack size, so usage was kept in pieces. Set the pack size and re-import.`);
        } else if (unit === "carton" && item.unit === "piece" && item.packSize) factor = item.packSize;
        const t = totals.get(r.sku) ?? {};
        for (const [d, q] of Object.entries(r.days)) t[d] = (t[d] ?? 0) + Number(q) * factor;
        totals.set(r.sku, t);
      }
      const dates = [...totals.values()].flatMap((t) => Object.keys(t)).sort();
      const id = Number(
        run(
          "INSERT INTO forecast_imports (filename, unit, from_date, to_date, rows, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          filename ?? null, unit, dates[0] ?? null, dates[dates.length - 1] ?? null, rows.length, nowIso(),
        ).lastInsertRowid,
      );
      for (const [sku, days] of totals) {
        for (const [d, q] of Object.entries(days)) {
          run("INSERT OR REPLACE INTO forecast (sku, date, qty, import_id) VALUES (?, ?, ?, ?)", sku, d, q, id);
        }
      }
      audit({ actor: who, action: "import", entity: "forecast", newValue: `${totals.size} SKUs, ${dates[0] ?? "?"} to ${dates[dates.length - 1] ?? "?"}`, note: filename });
    });
    res.json({ imported: totals.size, warnings: [...new Set(warnings)] });
  }),
);

// ---------- deliveries ----------

api.get("/delivery/open", (_req, res) => {
  const items = new Map(getItems().map((i) => [i.sku, i]));
  res.json(openOrderLines().map((l) => ({ ...l, name: items.get(l.sku)?.name ?? l.sku, outstanding: l.qty - l.received })));
});

api.post(
  "/delivery/ocr",
  upload.array("photos", 12),
  wrap(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) return bad(res, "Add at least one photo");
    const { ids, images } = saveImages(files);
    const items = getItems(false);
    try {
      const r = await readDeliveryNote(images, items.map((i) => ({ sku: i.sku, name: i.name })));
      if (!r.quality.readable) return bad(res, r.quality.problem || "The photo is not clear enough. Please retake it.", 422, { kind: "retake", photos: ids });
      const open = openOrderLines();
      res.json({
        photos: ids,
        supplier: r.supplier,
        reference: r.reference,
        date: r.date,
        lines: r.lines.map((l) => {
          const match = resolve("delivery", l.description || l.code, l.code || null, items);
          const outstanding = match.sku ? open.filter((o) => o.sku === match.sku).reduce((a, o) => a + o.qty - o.received, 0) : 0;
          return { ...l, match, outstanding };
        }),
      });
    } catch (e) {
      ocrFail(res, e);
    }
  }),
);

api.post(
  "/delivery/commit",
  wrap((req, res) => {
    const { date, supplier, reference, photos, lines } = req.body as {
      date: ISODate;
      supplier?: string;
      reference?: string;
      photos?: string[];
      lines: { sku: string; qty: number; ocrQty?: number | null; sourceName?: string; keepOpen?: boolean; confirmed?: boolean }[];
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return bad(res, "Invalid date");
    const valid = (lines ?? []).filter((l) => l.sku && Number(l.qty) > 0);
    if (!valid.length) return bad(res, "No delivery lines to save");
    for (const l of valid) if (!getItem(l.sku)) return bad(res, `Unknown SKU ${l.sku}`);
    const ts = nowIso();
    const stockBefore = engineInput().stock;
    const checks: { sku: string; delivered: number; ordered: number; shortage: number }[] = [];
    tx(() => {
      const sid = Number(
        run("INSERT INTO delivery_sessions (date, supplier, reference, photos, created_at) VALUES (?, ?, ?, ?, ?)", date, supplier ?? null, reference ?? null, JSON.stringify(photos ?? []), ts).lastInsertRowid,
      );
      // Merge lines per SKU so allocation against orders happens once.
      const bySku = new Map<string, { qty: number; ocrQty: number | null; sourceName?: string; keepOpen?: boolean }>();
      for (const l of valid) {
        const cur = bySku.get(l.sku);
        bySku.set(l.sku, {
          qty: (cur?.qty ?? 0) + Number(l.qty),
          ocrQty: l.ocrQty == null ? cur?.ocrQty ?? null : (cur?.ocrQty ?? 0) + Number(l.ocrQty),
          sourceName: cur?.sourceName ?? l.sourceName,
          keepOpen: cur?.keepOpen || l.keepOpen,
        });
        if (l.sourceName && l.confirmed) saveMapping("delivery", l.sourceName, l.sku, "confirmed", 1, actor());
      }
      for (const [sku, l] of bySku) {
        // Allocate against open order lines: those due by this date first (oldest
        // first), then any early arrivals of later orders. A shortfall on a due
        // line closes it unless the controller says the rest is still coming.
        const open = openOrderLines().filter((x) => x.sku === sku);
        const due = open.filter((x) => x.expected_delivery <= date);
        const later = open.filter((x) => x.expected_delivery > date);
        let left = l.qty;
        let ordered = 0;
        let early = 0;
        for (const o of [...due, ...later]) {
          const isDue = o.expected_delivery <= date;
          if (!isDue && left <= 0) break;
          const outstanding = o.qty - o.received;
          const take = Math.min(left, outstanding);
          if (isDue) ordered += outstanding;
          else early += take;
          left -= take;
          const received = o.received + take;
          const closed = received >= o.qty || (isDue && !l.keepOpen) ? 1 : 0;
          run("UPDATE order_lines SET received = ?, closed = ? WHERE id = ?", received, closed, o.id);
        }
        ordered += early;
        const shortage = ordered > 0 ? Math.max(0, ordered - l.qty) : 0;
        checks.push({ sku, delivered: l.qty, ordered, shortage });
        run(
          "INSERT INTO deliveries (session_id, date, sku, qty, ocr_qty, source_name, ordered_qty, shortage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          sid, date, sku, l.qty, l.ocrQty, l.sourceName ?? null, ordered || null, shortage || null, ts,
        );
        const via = l.ocrQty == null ? actor("manual delivery") : l.ocrQty === l.qty ? `OCR, confirmed by ${actor()}` : `${actor()} (corrected OCR ${l.ocrQty})`;
        const before = stockBefore[sku] ?? 0;
        audit({
          actor: via,
          action: "delivery",
          entity: "stock",
          sku,
          field: "stock",
          oldValue: before,
          newValue: before + l.qty,
          note: `Delivery ${date}${supplier ? ` from ${supplier}` : ""}${reference ? ` ref ${reference}` : ""}${shortage ? ` — short ${shortage} vs order` : ""}`,
        });
      }
    });
    res.json({ saved: checks.length, checks });
  }),
);

// ---------- orders ----------

api.get(
  "/orders",
  wrap((req, res) => {
    const limit = Math.min(500, Number(req.query.limit ?? 100));
    const orders = all<{ id: number; order_date: string; expected_delivery: string; placed_at: string; note: string | null }>(
      "SELECT * FROM orders ORDER BY id DESC LIMIT ?",
      limit,
    );
    const items = new Map(getItems().map((i) => [i.sku, i]));
    res.json(
      orders.map((o) => ({
        ...o,
        lines: all<{ id: number; sku: string; qty: number; received: number; closed: number; expected: string | null }>(
          "SELECT * FROM order_lines WHERE order_id = ? ORDER BY id",
          o.id,
        ).map((l) => ({ ...l, name: items.get(l.sku)?.name ?? l.sku, supplier: items.get(l.sku)?.supplier ?? null })),
      })),
    );
  }),
);

api.post(
  "/orders",
  wrap((req, res) => {
    const { lines, note } = req.body as { lines: { sku: string; qty: number }[]; note?: string };
    const valid = (lines ?? []).filter((l) => Number(l.qty) > 0);
    if (!valid.length) return bad(res, "No order lines");
    const s = getSettings();
    const t = today();
    const cal = { cutoff: s.cutoff, leadDays: s.leadDays, holidays: s.holidays };
    const orderDate = effectiveOrderDate(t.date, t.minutes, cal);
    const expected = deliveryDateFor(orderDate, cal);
    let id = 0;
    tx(() => {
      id = Number(run("INSERT INTO orders (order_date, expected_delivery, placed_at, note) VALUES (?, ?, ?, ?)", orderDate, expected, nowIso(), note ?? null).lastInsertRowid);
      for (const l of valid) {
        const item = getItem(l.sku);
        if (!item) throw new Error(`Unknown SKU ${l.sku}`);
        const lineExpected = deliveryDateFor(orderDate, calendarFor(item, s));
        run("INSERT INTO order_lines (order_id, sku, qty, expected) VALUES (?, ?, ?, ?)", id, l.sku, Number(l.qty), lineExpected);
        audit({ actor: actor(), action: "order", entity: "order", sku: l.sku, field: "qty", newValue: Number(l.qty), note: `Order #${id} booked ${orderDate}, expected ${lineExpected}` });
      }
    });
    res.json({ id, orderDate, expected });
  }),
);

api.put(
  "/orders/lines/:id",
  wrap((req, res) => {
    const line = get<{ id: number; sku: string; qty: number; closed: number; order_id: number }>("SELECT * FROM order_lines WHERE id = ?", Number(req.params.id));
    if (!line) return bad(res, "Unknown order line", 404);
    const { qty, closed } = req.body as { qty?: number; closed?: boolean };
    if (qty != null && (!Number.isFinite(Number(qty)) || Number(qty) < 0)) return bad(res, "Invalid quantity");
    tx(() => {
      if (qty != null && Number(qty) !== line.qty) {
        run("UPDATE order_lines SET qty = ? WHERE id = ?", Number(qty), line.id);
        audit({ actor: actor(), action: "update", entity: "order", sku: line.sku, field: "qty", oldValue: line.qty, newValue: Number(qty), note: `Order #${line.order_id}` });
      }
      if (closed != null && Number(!!closed) !== line.closed) {
        run("UPDATE order_lines SET closed = ? WHERE id = ?", closed ? 1 : 0, line.id);
        audit({ actor: actor(), action: "update", entity: "order", sku: line.sku, field: "closed", oldValue: !!line.closed, newValue: !!closed, note: `Order #${line.order_id}` });
      }
    });
    res.json({ ok: true });
  }),
);

api.delete(
  "/orders/:id",
  wrap((req, res) => {
    const id = Number(req.params.id);
    const lines = all<{ sku: string; qty: number; received: number }>("SELECT sku, qty, received FROM order_lines WHERE order_id = ?", id);
    if (!lines.length) return bad(res, "Unknown order", 404);
    if (lines.some((l) => l.received > 0)) return bad(res, "This order already has deliveries recorded against it. Close its lines instead.");
    tx(() => {
      run("DELETE FROM orders WHERE id = ?", id);
      for (const l of lines) audit({ actor: actor(), action: "delete", entity: "order", sku: l.sku, field: "qty", oldValue: l.qty, newValue: 0, note: `Order #${id} removed` });
    });
    res.json({ ok: true });
  }),
);

// ---------- reports ----------

function discrepancyReport() {
  const session = get<{ id: number; date: string }>("SELECT id, date FROM count_sessions ORDER BY created_at DESC LIMIT 1");
  if (!session) return { date: null, rows: [] };
  const inp = engineInput();
  const items = new Map(inp.items.map((i) => [i.sku, i]));
  const rows = all<{ sku: string; qty: number }>("SELECT sku, qty FROM counts WHERE session_id = ?", session.id).flatMap((c) => {
    const item = items.get(c.sku);
    if (!item) return [];
    // Compare with the count before this session.
    const prev = get<{ qty: number; date: string; created_at: string }>(
      "SELECT qty, date, created_at FROM counts WHERE sku = ? AND session_id != ? AND date < ? ORDER BY created_at DESC LIMIT 1",
      c.sku, session.id, session.date,
    );
    const d = discrepancyFor(item, c.qty, session.date, inp);
    return [{ sku: c.sku, name: item.name, counted: c.qty, prevDate: prev?.date ?? null, prevQty: prev?.qty ?? null, ...d }];
  });
  return { date: session.date, rows };
}

function deliveryReport(days = 30) {
  const since = addDays(today().date, -days);
  const items = new Map(getItems().map((i) => [i.sku, i]));
  const recent = all<{ date: string; sku: string; qty: number; ordered_qty: number | null; shortage: number | null; supplier: string | null; reference: string | null }>(
    `SELECT d.date, d.sku, d.qty, d.ordered_qty, d.shortage, s.supplier, s.reference
     FROM deliveries d LEFT JOIN delivery_sessions s ON s.id = d.session_id WHERE d.date >= ? ORDER BY d.created_at DESC`,
    since,
  ).map((r) => ({ ...r, name: items.get(r.sku)?.name ?? r.sku, unordered: r.ordered_qty == null }));
  const t = today().date;
  const overdue = openOrderLines()
    .filter((l) => l.expected_delivery < t)
    .map((l) => ({ ...l, name: items.get(l.sku)?.name ?? l.sku, outstanding: l.qty - l.received }));
  return { recent, overdue };
}

api.get("/reports/discrepancies", wrap((_req, res) => res.json(discrepancyReport())));
api.get("/reports/deliveries", wrap((req, res) => res.json(deliveryReport(Number(req.query.days ?? 30)))));

api.get(
  "/audit",
  wrap((req, res) => {
    const limit = Math.min(1000, Number(req.query.limit ?? 200));
    const sku = req.query.sku ? String(req.query.sku) : null;
    res.json(sku ? all("SELECT * FROM audit WHERE sku = ? ORDER BY id DESC LIMIT ?", sku, limit) : all("SELECT * FROM audit ORDER BY id DESC LIMIT ?", limit));
  }),
);

// ---------- exports ----------

const fmtN = (n: number | null | undefined, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const STATUS_LABEL = { ok: "OK", low: "LOW", critical: "CRITICAL", setup: "SETUP NEEDED" } as const;
const statusColor = (r: Record<string, unknown>) =>
  r.status === "CRITICAL" ? "red" : r.status === "LOW" ? "amber" : r.status === "OK" ? "green" : null;

function stockSheet(plans: ItemPlan[]) {
  return {
    name: "Stock",
    columns: [
      { header: "SKU", key: "sku", width: 14 },
      { header: "Item", key: "name", width: 50 },
      { header: "Supplier", key: "supplier", width: 30 },
      { header: "Unit", key: "unit", width: 8 },
      { header: "Pack size", key: "packSize", width: 10 },
      { header: "Stock", key: "stock", width: 10 },
      { header: "Incoming", key: "incoming", width: 10 },
      { header: "Avg daily usage", key: "avg", width: 14 },
      { header: "Usage source", key: "source", width: 12 },
      { header: "Safety stock", key: "safety", width: 12 },
      { header: "Min level", key: "min", width: 10 },
      { header: "Days of cover", key: "cover", width: 12 },
      { header: "Runs out", key: "depletion", width: 12 },
      { header: "Status", key: "status", width: 14 },
      { header: "Reason", key: "reason", width: 34 },
      { header: "Order qty", key: "order", width: 10 },
      { header: "Max holding", key: "max", width: 12 },
      { header: "Last ordered", key: "lastOrder", width: 12 },
      { header: "Days since order", key: "since", width: 14 },
    ],
    rows: plans.map((p) => ({
      sku: p.sku,
      name: p.name,
      supplier: p.supplier,
      unit: p.unit,
      packSize: p.packSize,
      stock: p.stock,
      incoming: p.incoming || null,
      avg: fmtN(p.avgDaily, 2),
      source: p.usageSource,
      safety: fmtN(p.safetyStock),
      min: p.minLevel,
      cover: fmtN(p.daysOfCover),
      depletion: p.depletionDate,
      status: STATUS_LABEL[p.status],
      reason: p.statusReason,
      order: p.orderQty || null,
      max: p.maxHolding,
      lastOrder: p.lastOrderDate,
      since: p.daysSinceOrder,
    })),
    highlight: statusColor,
  };
}

function orderSheet(plans: ItemPlan[], qtyOverride?: Map<string, number>) {
  const w = plans[0]?.window;
  const qty = (p: ItemPlan) => qtyOverride?.get(p.sku) ?? (qtyOverride ? 0 : p.orderQty);
  return {
    name: `Order ${w?.orderDate ?? ""}`,
    columns: [
      { header: "Supplier", key: "supplier", width: 32 },
      { header: "SKU", key: "sku", width: 14 },
      { header: "Item", key: "name", width: 54 },
      { header: "Order qty", key: "qty", width: 10 },
      { header: "Unit", key: "unit", width: 8 },
      { header: "Pieces", key: "pieces", width: 10 },
      { header: "Stock", key: "stock", width: 9 },
      { header: "Required", key: "required", width: 10 },
      { header: "Status", key: "status", width: 12 },
      { header: "Delivery", key: "delivery", width: 12 },
    ],
    rows: plans
      .filter((p) => qty(p) > 0)
      .sort((a, b) => (a.supplier ?? "").localeCompare(b.supplier ?? "") || a.name.localeCompare(b.name))
      .map((p) => ({
        supplier: p.supplier,
        sku: p.sku,
        name: p.name,
        qty: qty(p),
        unit: p.unit,
        pieces: p.packSize && p.unit === "carton" ? qty(p) * p.packSize : p.unit === "piece" ? qty(p) : null,
        stock: p.stock,
        required: fmtN(p.required),
        status: STATUS_LABEL[p.status],
        delivery: p.window.firstDelivery,
      })),
    highlight: statusColor,
  };
}

async function sendXlsx(res: Response, name: string, buf: Buffer) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(buf);
}

api.get(
  "/export/stock.xlsx",
  wrap(async (_req, res) => {
    const { plans, today: t } = currentPlan();
    await sendXlsx(res, `stock-${t}.xlsx`, await buildWorkbook([stockSheet(plans)]));
  }),
);

api.get(
  "/export/order.xlsx",
  wrap(async (_req, res) => {
    const { plans } = currentPlan();
    const date = plans[0]?.window.orderDate ?? today().date;
    await sendXlsx(res, `order-${date}.xlsx`, await buildWorkbook([orderSheet(plans)]));
  }),
);

// Order list as edited on screen.
api.post(
  "/export/order.xlsx",
  wrap(async (req, res) => {
    const lines = (req.body?.lines ?? []) as { sku: string; qty: number }[];
    const { plans } = currentPlan();
    const date = plans[0]?.window.orderDate ?? today().date;
    const override = new Map(lines.map((l) => [l.sku, Number(l.qty) || 0]));
    await sendXlsx(res, `order-${date}.xlsx`, await buildWorkbook([orderSheet(plans, override)]));
  }),
);

api.get(
  "/export/reports.xlsx",
  wrap(async (_req, res) => {
    const { plans, today: t } = currentPlan();
    const disc = discrepancyReport();
    const del = deliveryReport(60);
    const orders = all<Record<string, unknown>>(
      `SELECT o.id, o.order_date, COALESCE(l.expected, o.expected_delivery) expected, l.sku, i.name, l.qty, l.received, l.closed
       FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN items i ON i.sku = l.sku ORDER BY o.id DESC LIMIT 2000`,
    );
    const counts = all<Record<string, unknown>>(
      "SELECT c.date, c.sku, i.name, c.qty, c.ocr_qty, c.source, c.created_at FROM counts c LEFT JOIN items i ON i.sku = c.sku ORDER BY c.created_at DESC LIMIT 5000",
    );
    const auditRows = all<Record<string, unknown>>("SELECT * FROM audit ORDER BY id DESC LIMIT 5000");
    const buf = await buildWorkbook([
      stockSheet(plans),
      orderSheet(plans),
      {
        name: "Alerts",
        columns: [
          { header: "SKU", key: "sku" },
          { header: "Item", key: "name", width: 50 },
          { header: "Stock", key: "stock" },
          { header: "Last ordered", key: "last" },
          { header: "Days since order", key: "since" },
          { header: "Runs out", key: "runsOut" },
          { header: "Order by", key: "orderBy" },
          { header: "Warning", key: "warning", width: 60 },
        ],
        rows: plans
          .filter((p) => p.notOrderedFlag || p.depletion)
          .map((p) => ({
            sku: p.sku,
            name: p.name,
            stock: p.stock,
            last: p.lastOrderDate ?? "never",
            since: p.daysSinceOrder,
            runsOut: p.depletionDate,
            orderBy: p.depletion?.latestOrderDate ?? null,
            warning: p.depletion?.message ?? `Not ordered in ${getSettings().notOrderedDays}+ days`,
          })),
        highlight: (r) => (r.orderBy ? "red" : "amber"),
      },
      {
        name: `Discrepancies ${disc.date ?? ""}`,
        columns: [
          { header: "SKU", key: "sku" },
          { header: "Item", key: "name", width: 50 },
          { header: "Previous count", key: "prevQty" },
          { header: "Previous date", key: "prevDate" },
          { header: "Deliveries since", key: "deliveriesSince" },
          { header: "Expected", key: "expected" },
          { header: "Counted", key: "counted" },
          { header: "Gap", key: "gap" },
          { header: "Gap %", key: "gapPct" },
          { header: "Flagged", key: "flaggedText" },
        ],
        rows: disc.rows.map((r) => ({ ...r, expected: fmtN(r.expected), gap: fmtN(r.gap), gapPct: fmtN(r.gapPct, 0), flaggedText: r.flagged ? "YES" : "" })),
        highlight: (r) => (r.flaggedText ? "amber" : null),
      },
      {
        name: "Delivery check",
        columns: [
          { header: "Date", key: "date" },
          { header: "Supplier", key: "supplier", width: 28 },
          { header: "Reference", key: "reference" },
          { header: "SKU", key: "sku" },
          { header: "Item", key: "name", width: 50 },
          { header: "Ordered (open)", key: "ordered_qty" },
          { header: "Delivered", key: "qty" },
          { header: "Shortage", key: "shortage" },
          { header: "Note", key: "note", width: 24 },
        ],
        rows: [
          ...del.overdue.map((o) => ({ date: o.expected_delivery, sku: o.sku, name: o.name, ordered_qty: o.outstanding, qty: 0, shortage: o.outstanding, note: "Overdue — not delivered" })),
          ...del.recent.map((r) => ({ ...r, note: r.unordered ? "Not on an open order" : r.shortage ? "Short delivery" : "" })),
        ],
        highlight: (r) => (r.shortage ? "red" : r.note ? "amber" : null),
      },
      {
        name: "Order log",
        columns: [
          { header: "Order #", key: "id" },
          { header: "Booked", key: "order_date" },
          { header: "Expected", key: "expected" },
          { header: "SKU", key: "sku" },
          { header: "Item", key: "name", width: 50 },
          { header: "Qty", key: "qty" },
          { header: "Received", key: "received" },
          { header: "Closed", key: "closed" },
        ],
        rows: orders,
      },
      {
        name: "Count history",
        columns: [
          { header: "Date", key: "date" },
          { header: "SKU", key: "sku" },
          { header: "Item", key: "name", width: 50 },
          { header: "Count", key: "qty" },
          { header: "OCR read", key: "ocr_qty" },
          { header: "Source", key: "source" },
          { header: "Saved at", key: "created_at", width: 24 },
        ],
        rows: counts,
      },
      {
        name: "Audit trail",
        columns: [
          { header: "When (UTC)", key: "ts", width: 24 },
          { header: "Who / what", key: "actor", width: 36 },
          { header: "Action", key: "action" },
          { header: "Entity", key: "entity" },
          { header: "SKU", key: "sku" },
          { header: "Field", key: "field", width: 20 },
          { header: "Old", key: "old_value" },
          { header: "New", key: "new_value" },
          { header: "Note", key: "note", width: 50 },
        ],
        rows: auditRows,
      },
    ]);
    await sendXlsx(res, `stockroom-report-${t}.xlsx`, buf);
  }),
);

// ---------- push ----------

api.get("/push/key", (_req, res) => res.json({ key: vapidPublicKey() }));
api.post(
  "/push/subscribe",
  wrap((req, res) => {
    if (!req.body?.endpoint) return bad(res, "Invalid subscription");
    saveSubscription(req.body);
    audit({ actor: actor(), action: "subscribe", entity: "notifications" });
    res.json({ ok: true });
  }),
);
api.post(
  "/push/unsubscribe",
  wrap((req, res) => {
    removeSubscription(String(req.body?.endpoint ?? ""));
    res.json({ ok: true });
  }),
);
api.post(
  "/push/test",
  wrap(async (_req, res) => {
    const msg = orderReminderMessage() ?? { title: "Stockroom", body: "Notifications are working. Nothing to order right now.", url: "/#/" };
    res.json({ sent: await notifyAll(msg) });
  }),
);

api.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

export type { Settings };
