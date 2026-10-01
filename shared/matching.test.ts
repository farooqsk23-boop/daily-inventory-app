import { describe, expect, it } from "vitest";
import master from "../server/seed/master-inventory.json" with { type: "json" };
import { matchName, similarity } from "./matching.ts";

const candidates = master.map((m) => ({ sku: m.sku, name: m.name }));

describe("SKU matching", () => {
  it("matches an embedded SKU code exactly", () => {
    expect(matchName("HOT0217 lid flat", candidates)).toMatchObject({ sku: "HOT0217", level: "exact" });
  });

  it.each([
    ["Sabert Eco Local 30oz 6x9 Rect Pulp Cont Laminated", "PM00013034"],
    ["Sabert 36oz 6x9 rect pulp container", "PM00013033"],
    ["16oz Square PET Deli Container", "HOT0219"],
    ["12oz Square PET Deli Container", "HOT0218"],
    ["Calo Soup Bowl 750ml Lid Green", "PM00012789"],
    ["Calo Soup Bowl 400ml (no lid) green", "PM00012790"],
    ["Pulp Bowl Oval 770ml Sabert", "PM00013032"],
    ["Calo Green Bag", "PM00013457"],
    ["Branded ice pack 400g", "PM00007650"],
  ])("matches %s", (name, sku) => {
    expect(matchName(name, candidates).sku).toBe(sku);
  });

  it("keeps sizes apart", () => {
    const a = similarity("12 OZ SQUARE PET DELI CONTAINER", "16 OZ SQUARE PET DELI CONTAINER (500 PCS)");
    const b = similarity("12 OZ SQUARE PET DELI CONTAINER", "12 OZ SQUARE PET DELI CONTAINER (500 PCS)");
    expect(b).toBeGreaterThan(a + 0.2);
  });

  it("does not auto-accept unrelated names", () => {
    const r = matchName("Wooden chopsticks pair", candidates);
    expect(r.level === "none" || r.level === "confirm").toBe(true);
  });
});

describe("product kind words", () => {
  it("prefers the bowl over its lid when the source has no lid", () => {
    expect(matchName("Calo Soup Bowl 750ml", candidates).sku).toBe("PM00012788");
    expect(matchName("Calo Soup Bowl Lid 750ml", candidates).sku).toBe("PM00012789");
  });
});
