import type { ISODate } from "../../shared/calendar.ts";
import type { DashboardSummary, ItemPlan } from "../../shared/ordering.ts";
import type { Item, Settings } from "../../shared/types.ts";
import type { MatchResult } from "../../shared/matching.ts";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  let res: Response;
  try {
    res = await fetch(`/api${url}`, init);
  } catch {
    throw new ApiError("No connection to the server. Check your network and try again.", 0, {});
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : {};
  if (res.status === 401 && data.login) {
    window.dispatchEvent(new Event("stockroom:login"));
  }
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  del: <T>(url: string, body?: unknown) => request<T>("DELETE", url, body),
};

export async function download(url: string, filename: string, body?: unknown) {
  const res = await fetch(`/api${url}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ApiError("Export failed", res.status, {});
  saveBlob(await res.blob(), filename);
}

export function saveBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export interface Dashboard {
  today: ISODate;
  minutes: number;
  settings: Settings;
  plans: ItemPlan[];
  summary: DashboardSummary;
  isWorkingDay: boolean;
  lastCount: { date: string; created_at: string } | null;
  lastDelivery: { date: string } | null;
  lastImport: { created_at: string; from_date: string; to_date: string } | null;
  lastOrder: { order_date: string; placed_at: string } | null;
  unmatchedMappings: number;
  overdueDeliveries: number;
  ocr: boolean;
}

export interface OrderLog {
  id: number;
  order_date: string;
  expected_delivery: string;
  placed_at: string;
  note: string | null;
  lines: { id: number; sku: string; name: string; supplier: string | null; qty: number; received: number; closed: number; expected: string | null }[];
}

export interface OpenLine {
  id: number;
  order_id: number;
  sku: string;
  name: string;
  qty: number;
  received: number;
  outstanding: number;
  order_date: string;
  expected_delivery: string;
}

export type { Item, ItemPlan, Settings, MatchResult };
