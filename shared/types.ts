import type { ISODate } from "./calendar.ts";

export type StockUnit = "carton" | "piece";

export interface Item {
  sku: string;
  name: string;
  supplier: string | null;
  packSize: number | null; // pieces per carton
  unit: StockUnit; // unit the stock is counted/ordered in
  minLevel: number | null; // per-item minimum, in stock units
  maxHolding: number | null;
  avgDaily: number | null; // fallback average daily usage, in stock units
  leadDays: number | null; // per-item override of supplier lead time
  active: boolean;
  sortOrder: number;
}

export interface Settings {
  safetyMultiplier: number;
  cutoff: string; // "HH:MM"
  leadDays: number;
  timeZone: string;
  reminderTimes: string[]; // e.g. ["11:30", "12:15"]
  holidays: ISODate[];
  sundayUsage: boolean; // is packaging consumed on Sundays?
  depletionWarnDays: number; // 3
  notOrderedDays: number; // 30
  discrepancyPct: number; // flag gaps above this % of expected
  discrepancyMin: number; // ...and at least this many units
  controllerName: string;
  forecastHorizonDays: number; // how far ahead average usage is taken from the forecast
}

export const DEFAULT_SETTINGS: Settings = {
  safetyMultiplier: 1.3,
  cutoff: "12:30",
  leadDays: 1,
  timeZone: "Asia/Dubai",
  reminderTimes: ["11:30", "12:15"],
  holidays: [],
  sundayUsage: false,
  depletionWarnDays: 3,
  notOrderedDays: 30,
  discrepancyPct: 20,
  discrepancyMin: 2,
  controllerName: "Stockroom controller",
  forecastHorizonDays: 14,
};

export type Status = "ok" | "low" | "critical" | "setup";
