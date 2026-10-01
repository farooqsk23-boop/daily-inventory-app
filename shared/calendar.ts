// Calendar rules for the warehouse.
//  - Closed on Sunday: no ordering, no delivery (plus optional extra holidays).
//  - An order placed on a working day is delivered `leadDays` working days later
//    (default 1, so Saturday -> Monday).
//  - Orders placed at/after the cutoff (default 12:30) count as the next working day.
// All dates are plain "YYYY-MM-DD" strings in the warehouse's local time zone, so
// nothing here depends on the server's own clock zone.

export type ISODate = string;

export interface CalendarConfig {
  cutoff: string; // "HH:MM"
  leadDays: number; // working days between order and delivery
  holidays?: ISODate[]; // extra closed days
}

export function parseDate(d: ISODate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function fmtDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  const x = parseDate(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fmtDate(x);
}

export function weekday(d: ISODate): number {
  return parseDate(d).getUTCDay(); // 0 = Sunday
}

export function isSunday(d: ISODate): boolean {
  return weekday(d) === 0;
}

export function isWorkingDay(d: ISODate, cfg?: Pick<CalendarConfig, "holidays">): boolean {
  return !isSunday(d) && !(cfg?.holidays ?? []).includes(d);
}

export function nextWorkingDay(d: ISODate, cfg?: Pick<CalendarConfig, "holidays">): ISODate {
  let x = addDays(d, 1);
  while (!isWorkingDay(x, cfg)) x = addDays(x, 1);
  return x;
}

export function prevWorkingDay(d: ISODate, cfg?: Pick<CalendarConfig, "holidays">): ISODate {
  let x = addDays(d, -1);
  while (!isWorkingDay(x, cfg)) x = addDays(x, -1);
  return x;
}

/** Calendar days from a to b (b - a). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
}

/** Number of working days in the half-open range [a, b). */
export function workingDaysBetween(a: ISODate, b: ISODate, cfg?: Pick<CalendarConfig, "holidays">): number {
  let n = 0;
  for (let x = a; x < b; x = addDays(x, 1)) if (isWorkingDay(x, cfg)) n++;
  return n;
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** Local wall-clock date and minutes-of-day in an IANA time zone. */
export function localNow(timeZone: string, now: Date = new Date()): { date: ISODate; minutes: number; seconds: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    seconds: Number(parts.second),
  };
}

/** The working day an order placed "now" is booked on (cutoff and Sunday aware). */
export function effectiveOrderDate(today: ISODate, minutesOfDay: number, cfg: CalendarConfig): ISODate {
  if (isWorkingDay(today, cfg) && minutesOfDay < toMinutes(cfg.cutoff)) return today;
  return nextWorkingDay(today, cfg);
}

/** Delivery date for an order booked on `orderDate` (must be a working day). */
export function deliveryDateFor(orderDate: ISODate, cfg: CalendarConfig): ISODate {
  let d = orderDate;
  for (let i = 0; i < Math.max(1, cfg.leadDays); i++) d = nextWorkingDay(d, cfg);
  return d;
}

/** Latest working day an order can be booked on and still arrive on or before `by`. */
export function latestOrderDateFor(by: ISODate, cfg: CalendarConfig): ISODate {
  let o = isWorkingDay(by, cfg) ? by : prevWorkingDay(by, cfg);
  while (deliveryDateFor(o, cfg) > by) o = prevWorkingDay(o, cfg);
  return o;
}

export interface OrderWindow {
  orderDate: ISODate; // when today's order is booked
  firstDelivery: ISODate; // next possible delivery date
  nextOrderDate: ISODate; // the following ordering opportunity
  secondDelivery: ISODate; // when the following cycle's order would arrive
  beforeCutoff: boolean;
  cutoffAt: ISODate; // date whose cutoff applies to the current order
}

export function orderWindow(today: ISODate, minutesOfDay: number, cfg: CalendarConfig): OrderWindow {
  const orderDate = effectiveOrderDate(today, minutesOfDay, cfg);
  const firstDelivery = deliveryDateFor(orderDate, cfg);
  const nextOrderDate = nextWorkingDay(orderDate, cfg);
  const secondDelivery = deliveryDateFor(nextOrderDate, cfg);
  return {
    orderDate,
    firstDelivery,
    nextOrderDate,
    secondDelivery,
    beforeCutoff: orderDate === today,
    cutoffAt: orderDate,
  };
}

export function dateRange(from: ISODate, toExclusive: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let x = from; x < toExclusive; x = addDays(x, 1)) out.push(x);
  return out;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function prettyDate(d: ISODate, withDow = true): string {
  const x = parseDate(d);
  const s = `${x.getUTCDate()} ${MON[x.getUTCMonth()]}`;
  return withDow ? `${DOW[x.getUTCDay()]} ${s}` : s;
}
