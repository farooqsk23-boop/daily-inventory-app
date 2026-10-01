import { describe, expect, it } from "vitest";
import {
  deliveryDateFor,
  effectiveOrderDate,
  latestOrderDateFor,
  localNow,
  orderWindow,
  toMinutes,
  weekday,
  workingDaysBetween,
} from "./calendar.ts";

const cfg = { cutoff: "12:30", leadDays: 1, holidays: [] };
// 2026-10-03 is a Saturday, 2026-10-04 a Sunday.
const FRI = "2026-10-02";
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const MON = "2026-10-05";
const TUE = "2026-10-06";

describe("calendar", () => {
  it("knows the weekdays used in tests", () => {
    expect(weekday(SAT)).toBe(6);
    expect(weekday(SUN)).toBe(0);
  });

  it("books before-cutoff orders today and after-cutoff orders on the next working day", () => {
    expect(effectiveOrderDate(FRI, toMinutes("12:29"), cfg)).toBe(FRI);
    expect(effectiveOrderDate(FRI, toMinutes("12:30"), cfg)).toBe(SAT);
    expect(effectiveOrderDate(SAT, toMinutes("13:00"), cfg)).toBe(MON);
  });

  it("never orders on Sunday", () => {
    expect(effectiveOrderDate(SUN, toMinutes("09:00"), cfg)).toBe(MON);
  });

  it("delivers next day, Saturday orders on Monday", () => {
    expect(deliveryDateFor(FRI, cfg)).toBe(SAT);
    expect(deliveryDateFor(SAT, cfg)).toBe(MON);
    expect(deliveryDateFor(SAT, { ...cfg, leadDays: 2 })).toBe(TUE);
  });

  it("computes the full order window", () => {
    const w = orderWindow(FRI, toMinutes("10:00"), cfg);
    expect(w).toMatchObject({ orderDate: FRI, firstDelivery: SAT, nextOrderDate: SAT, secondDelivery: MON, beforeCutoff: true });
    const late = orderWindow(SAT, toMinutes("15:00"), cfg);
    expect(late).toMatchObject({ orderDate: MON, firstDelivery: TUE, beforeCutoff: false });
  });

  it("finds the latest order day that still arrives in time", () => {
    expect(latestOrderDateFor(MON, cfg)).toBe(SAT); // Sat order arrives Mon
    expect(latestOrderDateFor(SUN, cfg)).toBe(FRI); // nothing arrives Sunday; Fri -> Sat
    expect(latestOrderDateFor(TUE, cfg)).toBe(MON);
  });

  it("respects extra holidays", () => {
    const h = { ...cfg, holidays: [MON] };
    expect(deliveryDateFor(SAT, h)).toBe(TUE);
  });

  it("counts working days", () => {
    expect(workingDaysBetween(FRI, TUE, cfg)).toBe(3); // Fri, Sat, Mon
  });

  it("reads wall-clock time in the warehouse zone", () => {
    const t = localNow("Asia/Dubai", new Date("2026-10-01T20:30:00Z"));
    expect(t.date).toBe("2026-10-02");
    expect(t.minutes).toBe(30);
  });
});
