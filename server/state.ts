// Builds the engine input from the database and exposes the current plan.
import { addDays, localNow, type ISODate } from "../shared/calendar.ts";
import {
  averageUsage,
  discrepancy,
  observedUsage,
  planAll,
  summarize,
  type EngineInput,
  type Incoming,
} from "../shared/ordering.ts";
import type { Item } from "../shared/types.ts";
import { all, get, getItems, getSettings } from "./db.ts";

export function today(): { date: ISODate; minutes: number } {
  const s = getSettings();
  const n = localNow(s.timeZone);
  return { date: n.date, minutes: n.minutes };
}

interface CountRow {
  sku: string;
  qty: number;
  date: string;
  created_at: string;
}

/** Latest count per SKU. */
export function latestCounts(): Map<string, CountRow> {
  const rows = all<CountRow>(
    `SELECT c.sku, c.qty, c.date, c.created_at FROM counts c
     JOIN (SELECT sku, MAX(created_at) m FROM counts GROUP BY sku) l ON l.sku = c.sku AND l.m = c.created_at`,
  );
  return new Map(rows.map((r) => [r.sku, r]));
}

/** Current stock = last physical count + deliveries recorded after that count. */
export function currentStock(): Record<string, number | null> {
  const counts = latestCounts();
  const dels = all<{ sku: string; qty: number; created_at: string }>("SELECT sku, qty, created_at FROM deliveries");
  const out: Record<string, number | null> = {};
  for (const [sku, c] of counts) out[sku] = c.qty;
  for (const d of dels) {
    const c = counts.get(d.sku);
    if (!c) out[d.sku] = (out[d.sku] ?? 0) + d.qty;
    else if (d.created_at > c.created_at) out[d.sku] = (out[d.sku] ?? 0) + d.qty;
  }
  return out;
}

export function openOrderLines(): {
  id: number;
  order_id: number;
  sku: string;
  qty: number;
  received: number;
  order_date: string;
  expected_delivery: string;
}[] {
  return all(
    `SELECT l.id, l.order_id, l.sku, l.qty, l.received, o.order_date, COALESCE(l.expected, o.expected_delivery) expected_delivery
     FROM order_lines l JOIN orders o ON o.id = l.order_id
     WHERE l.closed = 0 AND l.qty > l.received ORDER BY o.order_date, l.id`,
  );
}

export function incoming(): Record<string, Incoming[]> {
  const out: Record<string, Incoming[]> = {};
  for (const l of openOrderLines()) {
    (out[l.sku] ??= []).push({ qty: l.qty - l.received, expected: l.expected_delivery });
  }
  return out;
}

export function forecastMap(from: ISODate): Record<string, Record<ISODate, number>> {
  const out: Record<string, Record<ISODate, number>> = {};
  for (const r of all<{ sku: string; date: string; qty: number }>("SELECT sku, date, qty FROM forecast WHERE date >= ?", from)) {
    (out[r.sku] ??= {})[r.date] = r.qty;
  }
  return out;
}

export function lastOrderDates(): Record<string, ISODate | null> {
  const out: Record<string, ISODate | null> = {};
  for (const r of all<{ sku: string; d: string }>(
    "SELECT l.sku, MAX(o.order_date) d FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.qty > 0 GROUP BY l.sku",
  ))
    out[r.sku] = r.d;
  return out;
}

export function deliveriesBetween(sku: string, fromCreatedAt: string, toCreatedAt: string): number {
  return (
    get<{ s: number | null }>(
      "SELECT SUM(qty) s FROM deliveries WHERE sku = ? AND created_at > ? AND created_at <= ?",
      sku, fromCreatedAt, toCreatedAt,
    )?.s ?? 0
  );
}

export function historyAverages(sinceDate: ISODate): Record<string, number | null> {
  const s = getSettings();
  const rows = all<CountRow>("SELECT sku, qty, date, created_at FROM counts WHERE date >= ? ORDER BY created_at", sinceDate);
  const bySku = new Map<string, CountRow[]>();
  for (const r of rows) {
    // Keep the last count of each day.
    const list = bySku.get(r.sku) ?? [];
    if (list.length && list[list.length - 1].date === r.date) list[list.length - 1] = r;
    else list.push(r);
    bySku.set(r.sku, list);
  }
  const out: Record<string, number | null> = {};
  for (const [sku, list] of bySku) {
    const created = new Map(list.map((c) => [c.date, c.created_at]));
    out[sku] = observedUsage(list, (a, b) => deliveriesBetween(sku, created.get(a)!, created.get(b)!), s);
  }
  return out;
}

export function engineInput(): EngineInput {
  const s = getSettings();
  const t = today();
  return {
    today: t.date,
    minutes: t.minutes,
    settings: s,
    items: getItems(false),
    stock: currentStock(),
    incoming: incoming(),
    forecast: forecastMap(addDays(t.date, -60)),
    lastOrderDate: lastOrderDates(),
    historyAvg: historyAverages(addDays(t.date, -45)),
  };
}

export function currentPlan() {
  const inp = engineInput();
  const plans = planAll(inp);
  return { today: inp.today, minutes: inp.minutes, settings: inp.settings, plans, summary: summarize(plans) };
}

/** Discrepancy for a proposed count of one item, compared with its previous count. */
export function discrepancyFor(item: Item, counted: number, countDate: ISODate, inp: EngineInput) {
  const prev = get<CountRow>(
    "SELECT sku, qty, date, created_at FROM counts WHERE sku = ? AND date < ? ORDER BY created_at DESC LIMIT 1",
    item.sku, countDate,
  );
  if (!prev) return { prev: null, ...discrepancy({ item, prevCount: null, deliveriesSince: 0, counted, countDate, avg: null }, inp) };
  const deliveriesSince =
    get<{ s: number | null }>("SELECT SUM(qty) s FROM deliveries WHERE sku = ? AND created_at > ?", item.sku, prev.created_at)?.s ?? 0;
  const { avg } = averageUsage(item, inp);
  return {
    prev: { date: prev.date, qty: prev.qty },
    deliveriesSince,
    ...discrepancy({ item, prevCount: { date: prev.date, qty: prev.qty }, deliveriesSince, counted, countDate, avg }, inp),
  };
}
