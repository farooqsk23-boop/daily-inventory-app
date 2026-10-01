import ExcelJS from "exceljs";
import { addDays, diffDays, type ISODate } from "../shared/calendar.ts";
import type { MasterRow } from "./db.ts";

// ---------- cell helpers ----------

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v && typeof v === "object") {
    if (v instanceof Date) return v;
    if ("result" in v) return (v as ExcelJS.CellFormulaValue).result ?? null;
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
    if ("text" in v) return (v as ExcelJS.CellHyperlinkValue).text;
    if ("error" in v) return null;
  }
  return v;
}

function text(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parse a header cell as a date. Year-less dates pick the year closest to `ref`. */
export function parseHeaderDate(v: unknown, ref: ISODate): ISODate | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    // Excel serial date (roughly 2020-2040).
    if (v > 43800 && v < 51200) return addDays("1899-12-30", Math.floor(v));
    return null;
  }
  const s = text(v).toLowerCase().replace(/(st|nd|rd|th)\b/g, "");
  if (!s) return null;
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/); // dd/mm/yyyy (UAE convention)
  if (m) return iso(fullYear(+m[3]), +m[2], +m[1]);
  m = s.match(/\b(\d{1,2})[\s-]*([a-z]{3})[a-z]*[\s,-]*(\d{2,4})?\b/); // 5 Oct (2026)
  if (m && MONTHS.includes(m[2])) return withYear(+m[1], MONTHS.indexOf(m[2]) + 1, m[3], ref);
  m = s.match(/\b([a-z]{3})[a-z]*[\s-]*(\d{1,2})\b[\s,-]*(\d{4})?/); // Oct 5 (2026)
  if (m && MONTHS.includes(m[1])) return withYear(+m[2], MONTHS.indexOf(m[1]) + 1, m[3], ref);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})$/); // dd/mm
  if (m) return withYear(+m[1], +m[2], undefined, ref);
  return null;
}

function fullYear(y: number) {
  return y < 100 ? 2000 + y : y;
}
function iso(y: number, m: number, d: number): ISODate | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function withYear(d: number, m: number, y: string | undefined, ref: ISODate): ISODate | null {
  if (y) return iso(fullYear(+y), m, d);
  const ry = +ref.slice(0, 4);
  const opts = [ry - 1, ry, ry + 1].map((yy) => iso(yy, m, d)).filter(Boolean) as ISODate[];
  return opts.sort((a, b) => Math.abs(diffDays(ref, a)) - Math.abs(diffDays(ref, b)))[0] ?? null;
}

function sheetRows(ws: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (c, col) => {
      vals[col - 1] = cellValue(c.value);
    });
    rows[n - 1] = vals;
  });
  return rows.map((r) => r ?? []);
}

// ---------- usage forecast ----------

export interface UsageRow {
  sourceName: string;
  code: string | null;
  days: Record<ISODate, number>;
}

export interface ParsedUsage {
  sheet: string;
  layout: "wide" | "long";
  rows: UsageRow[];
  from: ISODate | null;
  to: ISODate | null;
}

const NAME_HEADER = /(item|name|packag|description|product|material)/i;
const CODE_HEADER = /(sku|code|item ?no|item ?#|part)/i;

/**
 * Reads the dashboard packaging stats. Supports
 *  - wide layout: one row per packaging item, one column per date;
 *  - long layout: one row per item per date (date, item, quantity columns).
 */
export async function parseUsageWorkbook(buf: Buffer, ref: ISODate): Promise<ParsedUsage> {
  const wb = new ExcelJS.Workbook();
  if (/^[\x09\x0a\x0d\x20-\x7e]/.test(buf.subarray(0, 1).toString("latin1")) && !buf.subarray(0, 2).equals(Buffer.from("PK"))) {
    const { Readable } = await import("node:stream");
    await wb.csv.read(Readable.from(buf));
  } else {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  }
  const errors: string[] = [];
  for (const ws of wb.worksheets) {
    const rows = sheetRows(ws);
    const parsed = parseWide(ws.name, rows, ref) ?? parseLong(ws.name, rows, ref);
    if (parsed && parsed.rows.length) return parsed;
    errors.push(ws.name);
  }
  throw new Error(
    `Could not find daily usage in ${errors.join(", ") || "the file"}. Expected item names in one column and either one column per date, or Date / Item / Quantity columns.`,
  );
}

function parseWide(sheet: string, rows: unknown[][], ref: ISODate): ParsedUsage | null {
  for (let h = 0; h < Math.min(rows.length, 20); h++) {
    const header = rows[h];
    const dateCols: { col: number; date: ISODate }[] = [];
    header.forEach((v, col) => {
      const d = parseHeaderDate(v, ref);
      if (d) dateCols.push({ col, date: d });
    });
    if (dateCols.length < 2) continue;
    const firstDateCol = Math.min(...dateCols.map((d) => d.col));
    let nameCol = header.findIndex((v, i) => i < firstDateCol && NAME_HEADER.test(text(v)) && !CODE_HEADER.test(text(v)));
    const codeCol = header.findIndex((v, i) => i < firstDateCol && CODE_HEADER.test(text(v)));
    if (nameCol < 0) {
      // First column left of the dates that mostly holds text.
      for (let c = 0; c < firstDateCol; c++) {
        const textual = rows.slice(h + 1, h + 30).filter((r) => typeof r[c] === "string" && /[a-z]/i.test(r[c] as string)).length;
        if (textual >= 3 && c !== codeCol) {
          nameCol = c;
          break;
        }
      }
    }
    if (nameCol < 0) continue;
    const out: UsageRow[] = [];
    for (const r of rows.slice(h + 1)) {
      const name = text(r[nameCol]);
      if (!name || /^(total|grand total|sum)$/i.test(name)) continue;
      const days: Record<ISODate, number> = {};
      for (const dc of dateCols) {
        const n = num(r[dc.col]);
        if (n != null) days[dc.date] = n;
      }
      if (!Object.keys(days).length) continue;
      out.push({ sourceName: name, code: codeCol >= 0 ? text(r[codeCol]) || null : null, days });
    }
    return finish(sheet, "wide", out);
  }
  return null;
}

function parseLong(sheet: string, rows: unknown[][], ref: ISODate): ParsedUsage | null {
  for (let h = 0; h < Math.min(rows.length, 20); h++) {
    const header = rows[h].map(text);
    const dateCol = header.findIndex((v) => /^(date|day|delivery date|production date)$/i.test(v));
    const qtyCol = header.findIndex((v) => /(qty|quantity|usage|count|total|units|pcs)/i.test(v));
    const nameCol = header.findIndex((v, i) => i !== qtyCol && NAME_HEADER.test(v) && !CODE_HEADER.test(v));
    const codeCol = header.findIndex((v, i) => i !== qtyCol && i !== nameCol && CODE_HEADER.test(v));
    if (dateCol < 0 || qtyCol < 0 || (nameCol < 0 && codeCol < 0)) continue;
    const byName = new Map<string, UsageRow>();
    for (const r of rows.slice(h + 1)) {
      const date = parseHeaderDate(r[dateCol], ref);
      const qty = num(r[qtyCol]);
      const name = text(r[nameCol >= 0 ? nameCol : codeCol]);
      if (!date || qty == null || !name) continue;
      const row = byName.get(name) ?? { sourceName: name, code: codeCol >= 0 ? text(r[codeCol]) || null : null, days: {} };
      row.days[date] = (row.days[date] ?? 0) + qty;
      byName.set(name, row);
    }
    return finish(sheet, "long", [...byName.values()]);
  }
  return null;
}

function finish(sheet: string, layout: "wide" | "long", rows: UsageRow[]): ParsedUsage {
  // Merge duplicate names.
  const merged = new Map<string, UsageRow>();
  for (const r of rows) {
    const cur = merged.get(r.sourceName);
    if (!cur) merged.set(r.sourceName, { ...r, days: { ...r.days } });
    else for (const [d, q] of Object.entries(r.days)) cur.days[d] = (cur.days[d] ?? 0) + q;
  }
  const dates = rows.flatMap((r) => Object.keys(r.days)).sort();
  return { sheet, layout, rows: [...merged.values()], from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}

// ---------- master inventory ----------

/** Reads the "Master Inventory" sheet of the daily inventory workbook. */
export async function parseMasterWorkbook(buf: Buffer): Promise<MasterRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => /master/i.test(w.name)) ?? wb.worksheets[0];
  const rows = sheetRows(ws);
  const h = rows.findIndex((r) => r.some((v) => /^sku$/i.test(text(v))));
  if (h < 0) throw new Error(`No "SKU" header found on sheet "${ws.name}".`);
  const header = rows[h].map(text);
  const col = (re: RegExp) => header.findIndex((v) => re.test(v));
  const c = {
    sku: col(/^sku$/i),
    supplier: col(/supplier/i),
    name: col(/item name|^name|description/i),
    avg: col(/avg|average/i),
    max: col(/max/i),
    pack: col(/pack|carton/i),
  };
  if (c.name < 0) throw new Error('No "Item Name" column found.');
  return rows
    .slice(h + 1)
    .filter((r) => text(r[c.sku]) && text(r[c.name]))
    .map((r) => ({
      sku: text(r[c.sku]),
      name: text(r[c.name]),
      supplier: c.supplier >= 0 ? text(r[c.supplier]) || null : null,
      avgDaily: c.avg >= 0 ? num(r[c.avg]) : null,
      maxHolding: c.max >= 0 ? num(r[c.max]) : null,
      packSize: c.pack >= 0 ? num(r[c.pack]) : null,
    }));
}

// ---------- export ----------

const GREEN = "FF1F9D55";

export interface SheetSpec {
  name: string;
  columns: { header: string; key: string; width?: number; numFmt?: string }[];
  rows: Record<string, unknown>[];
  highlight?: (row: Record<string, unknown>) => "red" | "amber" | "green" | null;
}

export async function buildWorkbook(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Stockroom";
  wb.created = new Date();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = spec.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 14, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    for (const r of spec.rows) {
      const row = ws.addRow(r);
      const h = spec.highlight?.(r);
      if (h) {
        const color = h === "red" ? "FFFDE2E1" : h === "amber" ? "FFFFF4D6" : "FFE6F6EC";
        row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
      }
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
