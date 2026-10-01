import { describe, expect, it } from "vitest";
import { toMinutes } from "./calendar.ts";
import { discrepancy, observedUsage, planItem, project, roundOrder, type EngineInput } from "./ordering.ts";
import { DEFAULT_SETTINGS, type Item } from "./types.ts";

const FRI = "2026-10-02";
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const MON = "2026-10-05";

const item: Item = {
  sku: "PM1",
  name: "Test container",
  supplier: "S",
  packSize: 300,
  unit: "carton",
  minLevel: null,
  maxHolding: 100,
  avgDaily: 10,
  leadDays: null,
  active: true,
  sortOrder: 0,
};

function input(over: Partial<EngineInput> = {}): EngineInput {
  return {
    today: FRI,
    minutes: toMinutes("09:00"),
    settings: DEFAULT_SETTINGS,
    items: [item],
    stock: { PM1: 30 },
    incoming: {},
    forecast: {},
    lastOrderDate: { PM1: "2026-09-25" },
    historyAvg: {},
    ...over,
  };
}

describe("order quantity", () => {
  it("covers usage until the second delivery plus 1.3x safety stock", () => {
    // Fri before cutoff: order Fri -> delivered Sat; next order Sat -> delivered Mon.
    // Usage days in [Fri, Mon): Fri, Sat (Sunday closed) = 2 x 10 = 20. Safety 13.
    const p = planItem(item, input());
    expect(p.window.secondDelivery).toBe(MON);
    expect(p.usageUntilSecondDelivery).toBe(20);
    expect(p.safetyStock).toBeCloseTo(13);
    expect(p.required).toBeCloseTo(33);
    expect(p.rawOrder).toBeCloseTo(3);
    expect(p.orderQty).toBe(3);
  });

  it("subtracts confirmed incoming deliveries", () => {
    const p = planItem(item, input({ incoming: { PM1: [{ qty: 5, expected: SAT }] } }));
    expect(p.orderQty).toBe(0);
  });

  it("uses the forecast file when present, including Sunday usage if the file has it", () => {
    const p = planItem(item, input({ forecast: { PM1: { [FRI]: 20, [SAT]: 20, [SUN]: 5, [MON]: 20 } } }));
    // 20 + 20 + 5 = 45 used before Monday's delivery.
    expect(p.usageUntilSecondDelivery).toBe(45);
    expect(p.usageSource).toBe("forecast");
  });

  it("uses a per-item minimum when it is higher than safety stock", () => {
    const p = planItem({ ...item, minLevel: 40 }, input());
    expect(p.required).toBeCloseTo(60);
    expect(p.orderQty).toBe(30);
  });

  it("rounds to pack multiples for items counted in pieces", () => {
    expect(roundOrder(301, { unit: "piece", packSize: 300 })).toBe(600);
    expect(roundOrder(2.1, { unit: "carton", packSize: 300 })).toBe(3);
    expect(roundOrder(-4, { unit: "carton", packSize: null })).toBe(0);
  });
});

describe("status", () => {
  it("is critical when it runs out before the next possible delivery", () => {
    // Saturday after cutoff: next delivery is Tuesday. 15 cartons at 10/day lasts Sat + half of Mon.
    const p = planItem(item, input({ today: SAT, minutes: toMinutes("14:00"), stock: { PM1: 15 } }));
    expect(p.window.firstDelivery).toBe("2026-10-06");
    expect(p.status).toBe("critical");
  });

  it("is low when below safety stock", () => {
    const p = planItem(item, input({ stock: { PM1: 12 }, minutes: toMinutes("09:00") }));
    // 12 lasts Fri + 0.2 of Sat; first delivery is Sat so not critical.
    expect(p.status).toBe("low");
  });

  it("is ok with plenty of stock", () => {
    expect(planItem(item, input({ stock: { PM1: 60 } })).status).toBe("ok");
  });
});

describe("days of cover and depletion", () => {
  it("skips Sundays when counting cover", () => {
    const r = project(item, 25, FRI, 10, { settings: DEFAULT_SETTINGS, forecast: {} });
    // Fri 10, Sat 10, Sun 0, Mon 5 of 10 -> 2.5 usage days, empty on Monday.
    expect(r.daysOfCover).toBeCloseTo(2.5);
    expect(r.depletionDate).toBe(MON);
  });

  it("warns items not ordered for 30+ days that will run out soon", () => {
    const p = planItem(item, input({ stock: { PM1: 35 }, lastOrderDate: { PM1: "2026-08-01" } }));
    expect(p.notOrderedFlag).toBe(true);
    // 35 at 10/day: Fri, Sat, (Sun closed), Mon -> empty on Tue 6 Oct.
    // Last order that arrives in time is Mon 5 Oct, 3 days away -> warn.
    expect(p.depletion?.depletionDate).toBe("2026-10-06");
    expect(p.depletion?.latestOrderDate).toBe(MON);
    expect(p.depletion?.severity).toBe("soon");
  });

  it("stays quiet while the order deadline is more than 3 days away", () => {
    const p = planItem(item, input({ stock: { PM1: 45 }, lastOrderDate: {} }));
    expect(p.depletionDate).toBe("2026-10-07");
    expect(p.depletion).toBeNull();
  });

  it("does not raise depletion warnings for recently ordered items", () => {
    const p = planItem(item, input({ stock: { PM1: 15 } }));
    expect(p.notOrderedFlag).toBe(false);
    expect(p.depletion).toBeNull();
  });

  it("flags items never ordered as not ordered", () => {
    expect(planItem(item, input({ lastOrderDate: {} })).notOrderedFlag).toBe(true);
  });
});

describe("discrepancy", () => {
  it("compares the count with previous count + deliveries - usage", () => {
    const d = discrepancy(
      { item, prevCount: { date: FRI, qty: 50 }, deliveriesSince: 10, counted: 30, countDate: MON, avg: 10 },
      { settings: DEFAULT_SETTINGS, forecast: {} },
    );
    // Expected 50 + 10 - (Fri, Sat) 20 = 40; counted 30 -> gap -10 (25%).
    expect(d.expected).toBe(40);
    expect(d.gap).toBe(-10);
    expect(d.flagged).toBe(true);
  });

  it("derives observed usage from counts", () => {
    const u = observedUsage(
      [
        { date: FRI, qty: 50 },
        { date: MON, qty: 40 },
      ],
      () => 10,
      DEFAULT_SETTINGS,
    );
    expect(u).toBe(10); // 50 + 10 - 40 = 20 over 2 working days
  });
});
