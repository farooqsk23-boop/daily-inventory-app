// Order, status and depletion engine. Pure functions: everything the app shows on
// the dashboard and order list is derived here from stock, forecast and settings.
import {
  addDays,
  dateRange,
  diffDays,
  isSunday,
  isWorkingDay,
  latestOrderDateFor,
  orderWindow,
  workingDaysBetween,
  type CalendarConfig,
  type ISODate,
  type OrderWindow,
} from "./calendar.ts";
import type { Item, Settings, Status } from "./types.ts";

export type UsageSource = "forecast" | "master" | "history" | "none";

export interface Incoming {
  qty: number; // outstanding quantity, in stock units
  expected: ISODate;
}

export interface EngineInput {
  today: ISODate;
  minutes: number; // local minutes since midnight
  settings: Settings;
  items: Item[];
  stock: Record<string, number | null>; // current stock (last count + deliveries since)
  incoming: Record<string, Incoming[]>; // confirmed open orders
  forecast: Record<string, Record<ISODate, number>>; // daily usage in stock units
  lastOrderDate: Record<string, ISODate | null>;
  historyAvg: Record<string, number | null>; // average daily usage observed from counts
}

export interface ItemPlan {
  sku: string;
  name: string;
  supplier: string | null;
  unit: Item["unit"];
  packSize: number | null;
  stock: number | null;
  incoming: number;
  avgDaily: number | null;
  usageSource: UsageSource;
  safetyStock: number;
  minLevel: number | null;
  window: OrderWindow;
  usageUntilFirstDelivery: number;
  usageUntilSecondDelivery: number;
  required: number;
  rawOrder: number; // before rounding
  orderQty: number; // rounded up to whole cartons / pack multiples
  orderPieces: number | null;
  status: Status;
  statusReason: string;
  daysOfCover: number | null; // usage days covered by current stock
  depletionDate: ISODate | null; // first day stock (incl. incoming) is fully used up
  lastOrderDate: ISODate | null;
  daysSinceOrder: number | null;
  notOrderedFlag: boolean;
  depletion: DepletionWarning | null;
  overMaxHolding: boolean;
  maxHolding: number | null;
}

export interface DepletionWarning {
  depletionDate: ISODate;
  latestOrderDate: ISODate; // last booking day (before cutoff) that still arrives in time
  daysToDepletion: number;
  severity: "too-late" | "order-now" | "soon";
  message: string;
}

const PROJECTION_DAYS = 120;

export function calendarFor(item: Item, s: Settings): CalendarConfig {
  return { cutoff: s.cutoff, leadDays: item.leadDays ?? s.leadDays, holidays: s.holidays };
}

/** Average daily usage and where it came from. */
export function averageUsage(
  item: Item,
  inp: Pick<EngineInput, "today" | "settings" | "forecast" | "historyAvg">,
): { avg: number | null; source: UsageSource } {
  const f = inp.forecast[item.sku];
  if (f) {
    const end = addDays(inp.today, inp.settings.forecastHorizonDays);
    const days = Object.keys(f).filter(
      (d) => d >= inp.today && d < end && (inp.settings.sundayUsage || !isSunday(d)),
    );
    if (days.length) {
      return { avg: days.reduce((a, d) => a + f[d], 0) / days.length, source: "forecast" };
    }
  }
  if (item.avgDaily != null && item.avgDaily > 0) return { avg: item.avgDaily, source: "master" };
  const h = inp.historyAvg[item.sku];
  if (h != null && h > 0) return { avg: h, source: "history" };
  return { avg: null, source: "none" };
}

/** Expected usage of one item on one day: forecast when present, otherwise the average. */
export function usageOn(
  item: Item,
  date: ISODate,
  avg: number | null,
  inp: Pick<EngineInput, "settings" | "forecast">,
): number {
  const f = inp.forecast[item.sku];
  if (f && f[date] != null) return f[date];
  if (!inp.settings.sundayUsage && isSunday(date)) return 0;
  if (inp.settings.holidays.includes(date) && !inp.settings.sundayUsage) return 0;
  return avg ?? 0;
}

export function sumUsage(item: Item, from: ISODate, toExcl: ISODate, avg: number | null, inp: Pick<EngineInput, "settings" | "forecast">): number {
  return dateRange(from, toExcl).reduce((a, d) => a + usageOn(item, d, avg, inp), 0);
}

export function roundOrder(raw: number, item: Pick<Item, "unit" | "packSize">): number {
  if (raw <= 0) return 0;
  const eps = 1e-9;
  if (item.unit === "piece" && item.packSize && item.packSize > 0) {
    return Math.ceil(raw / item.packSize - eps) * item.packSize;
  }
  return Math.ceil(raw - eps);
}

/**
 * Walk stock forward day by day. Returns the first day stock is fully used up and
 * how many usage days the starting stock covers (fractional for the last day).
 * Days with zero usage (Sundays when closed) do not count as cover.
 */
export function project(
  item: Item,
  start: number,
  today: ISODate,
  avg: number | null,
  inp: Pick<EngineInput, "settings" | "forecast">,
  incoming: Incoming[] = [],
): { depletionDate: ISODate | null; daysOfCover: number | null } {
  if (avg == null && !inp.forecast[item.sku]) return { depletionDate: null, daysOfCover: null };
  let stock = start;
  let cover = 0;
  let coverDone = false;
  let depletionDate: ISODate | null = start <= 0 ? today : null;
  let d = today;
  for (let i = 0; i < PROJECTION_DAYS; i++, d = addDays(d, 1)) {
    for (const inc of incoming) if (inc.expected === d) stock += inc.qty;
    const u = usageOn(item, d, avg, inp);
    if (u > 0 && !coverDone) {
      if (stock >= u) cover += 1;
      else {
        cover += Math.max(0, stock) / u;
        coverDone = true;
      }
    }
    stock -= u;
    if (depletionDate == null && stock <= 0 && u > 0) depletionDate = d;
    if (depletionDate && coverDone) break;
  }
  return { depletionDate, daysOfCover: coverDone ? cover : cover >= PROJECTION_DAYS ? null : cover };
}

export function planItem(item: Item, inp: EngineInput): ItemPlan {
  const s = inp.settings;
  const cal = calendarFor(item, s);
  const window = orderWindow(inp.today, inp.minutes, cal);
  const { avg, source } = averageUsage(item, inp);
  const stock = inp.stock[item.sku] ?? null;
  const inc = inp.incoming[item.sku] ?? [];
  const incoming = inc.reduce((a, x) => a + x.qty, 0);

  const usageUntilFirstDelivery = sumUsage(item, inp.today, window.firstDelivery, avg, inp);
  const usageUntilSecondDelivery = sumUsage(item, inp.today, window.secondDelivery, avg, inp);
  const safetyStock = avg != null ? s.safetyMultiplier * avg : 0;
  const hasUsage = avg != null || !!inp.forecast[item.sku];
  // Required = usage until the second delivery + safety stock. A per-item minimum
  // level, when higher, replaces safety stock as the floor left after the cycle.
  const required = usageUntilSecondDelivery + Math.max(safetyStock, item.minLevel ?? 0);
  const rawOrder = stock == null || (!hasUsage && item.minLevel == null) ? 0 : required - (stock + incoming);
  const orderQty = roundOrder(rawOrder, item);
  const orderPieces =
    item.packSize && item.unit === "carton" ? orderQty * item.packSize : item.unit === "piece" ? orderQty : null;

  const proj = stock == null ? { depletionDate: null, daysOfCover: null } : project(item, stock, inp.today, avg, inp);
  const projIn = stock == null ? { depletionDate: null } : project(item, stock, inp.today, avg, inp, inc);

  // Status: red = out of stock or runs out before an order placed now can arrive,
  // amber = below safety stock or the per-item minimum, green = OK.
  let status: Status = "ok";
  let statusReason = "Stock covers the cycle";
  if (stock == null) {
    status = "setup";
    statusReason = "No count yet";
  } else if (stock <= 0) {
    status = "critical";
    statusReason = "Out of stock";
  } else if (projIn.depletionDate && projIn.depletionDate < window.firstDelivery) {
    status = "critical";
    statusReason = "Runs out before the next possible delivery";
  } else if (item.minLevel != null && stock < item.minLevel) {
    status = "low";
    statusReason = "Below minimum level";
  } else if (hasUsage && stock < safetyStock) {
    status = "low";
    statusReason = "Below safety stock";
  } else if (!hasUsage && item.minLevel == null) {
    status = "setup";
    statusReason = "No usage data or minimum level";
  }

  const lastOrderDate = inp.lastOrderDate[item.sku] ?? null;
  const daysSinceOrder = lastOrderDate ? diffDays(lastOrderDate, inp.today) : null;
  const notOrderedFlag = daysSinceOrder == null || daysSinceOrder > s.notOrderedDays;

  let depletion: DepletionWarning | null = null;
  if (notOrderedFlag && projIn.depletionDate) {
    depletion = depletionWarning(projIn.depletionDate, inp.today, window, cal, s.depletionWarnDays);
  }

  return {
    sku: item.sku,
    name: item.name,
    supplier: item.supplier,
    unit: item.unit,
    packSize: item.packSize,
    stock,
    incoming,
    avgDaily: avg,
    usageSource: source,
    safetyStock,
    minLevel: item.minLevel,
    window,
    usageUntilFirstDelivery,
    usageUntilSecondDelivery,
    required,
    rawOrder,
    orderQty,
    orderPieces,
    status,
    statusReason,
    daysOfCover: proj.daysOfCover,
    depletionDate: projIn.depletionDate,
    lastOrderDate,
    daysSinceOrder,
    notOrderedFlag,
    depletion,
    overMaxHolding: item.maxHolding != null && stock != null && stock + incoming + orderQty > item.maxHolding,
    maxHolding: item.maxHolding,
  };
}

/**
 * Depletion warning. The deadline that matters is the last booking day whose
 * delivery still lands on or before the depletion day; that already includes the
 * lead time, the 12:30 cutoff and the Sunday closure. We warn once that deadline
 * is `warnDays` calendar days away or closer, so there are always a few
 * ordering opportunities left when the alert first appears.
 */
export function depletionWarning(
  depletionDate: ISODate,
  today: ISODate,
  window: OrderWindow,
  cal: CalendarConfig,
  warnDays: number,
): DepletionWarning | null {
  const latestOrderDate = latestOrderDateFor(depletionDate, cal);
  const daysToDepletion = diffDays(today, depletionDate);
  const daysToDeadline = diffDays(today, latestOrderDate);
  if (daysToDepletion > warnDays && daysToDeadline > warnDays) return null;
  let severity: DepletionWarning["severity"];
  let message: string;
  if (latestOrderDate < window.orderDate) {
    severity = "too-late";
    message = "Will run out before the earliest delivery — order now and arrange an urgent delivery";
  } else if (latestOrderDate === window.orderDate) {
    severity = "order-now";
    message = window.beforeCutoff ? "Order today before the cutoff" : "Order on the next ordering day";
  } else {
    severity = "soon";
    message = `Order by ${latestOrderDate}`;
  }
  return { depletionDate, latestOrderDate, daysToDepletion, severity, message };
}

export function planAll(inp: EngineInput): ItemPlan[] {
  return inp.items.filter((i) => i.active).map((i) => planItem(i, inp));
}

export interface DashboardSummary {
  totalSkus: number;
  ok: number;
  low: number;
  critical: number;
  setup: number;
  toOrder: number;
  notOrdered: number;
  depletionAlerts: number;
}

export function summarize(plans: ItemPlan[]): DashboardSummary {
  return {
    totalSkus: plans.length,
    ok: plans.filter((p) => p.status === "ok").length,
    low: plans.filter((p) => p.status === "low").length,
    critical: plans.filter((p) => p.status === "critical").length,
    setup: plans.filter((p) => p.status === "setup").length,
    toOrder: plans.filter((p) => p.orderQty > 0).length,
    notOrdered: plans.filter((p) => p.notOrderedFlag).length,
    depletionAlerts: plans.filter((p) => p.depletion).length,
  };
}

// ---------- Discrepancy check ----------

export interface DiscrepancyInput {
  item: Item;
  prevCount: { date: ISODate; qty: number } | null;
  deliveriesSince: number;
  counted: number;
  countDate: ISODate;
  avg: number | null;
}

export interface Discrepancy {
  expected: number | null;
  gap: number | null; // counted - expected
  gapPct: number | null;
  flagged: boolean;
}

export function discrepancy(d: DiscrepancyInput, inp: Pick<EngineInput, "settings" | "forecast">): Discrepancy {
  if (!d.prevCount || d.prevCount.date >= d.countDate) return { expected: null, gap: null, gapPct: null, flagged: false };
  const used = sumUsage(d.item, d.prevCount.date, d.countDate, d.avg, inp);
  const expected = d.prevCount.qty + d.deliveriesSince - used;
  const gap = d.counted - expected;
  const gapPct = expected !== 0 ? (gap / Math.abs(expected)) * 100 : null;
  const flagged =
    Math.abs(gap) >= inp.settings.discrepancyMin &&
    (gapPct == null || Math.abs(gapPct) >= inp.settings.discrepancyPct);
  return { expected, gap, gapPct, flagged };
}

/** Observed average daily usage between consecutive counts (working days only). */
export function observedUsage(
  counts: { date: ISODate; qty: number }[],
  deliveriesBetween: (from: ISODate, to: ISODate) => number,
  settings: Settings,
): number | null {
  const sorted = [...counts].sort((a, b) => (a.date < b.date ? -1 : 1));
  let used = 0;
  let days = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const n = settings.sundayUsage ? diffDays(a.date, b.date) : workingDaysBetween(a.date, b.date, settings);
    if (n <= 0) continue;
    const u = a.qty + deliveriesBetween(a.date, b.date) - b.qty;
    if (u < 0) continue; // a recount or correction, not usage
    used += u;
    days += n;
  }
  return days > 0 ? used / days : null;
}

export { isWorkingDay };
