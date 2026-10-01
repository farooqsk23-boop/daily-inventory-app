import { useMemo, useState } from "react";
import { addDays, isSunday } from "../../../shared/calendar.ts";
import type { ItemPlan } from "../../../shared/ordering.ts";
import type { Status } from "../../../shared/types.ts";
import { api, type Item } from "../api.ts";
import { useDash } from "../App.tsx";
import { StockChart, UsageBars, type EventMark, type StockPoint } from "../charts.tsx";
import { Back, ErrorBox, Icon, Loading, StatusPill, TopBar, errMsg, routeQuery, useLoad, useToast } from "../ui.tsx";
import { day, fmt, timeAgo, unitLabel } from "../util.ts";

type Filter = "all" | Status | "order" | "noorder";

export function Items() {
  const { dash, refresh } = useDash();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>((routeQuery().get("status") as Filter) ?? "all");
  const [adding, setAdding] = useState(false);
  const plans = dash!.plans;
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: plans.length };
    for (const p of plans) c[p.status] = (c[p.status] ?? 0) + 1;
    c.order = plans.filter((p) => p.orderQty > 0).length;
    c.noorder = plans.filter((p) => p.notOrderedFlag).length;
    return c;
  }, [plans]);
  const shown = plans.filter((p) => {
    if (q && !`${p.name} ${p.sku} ${p.supplier}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === "all") return true;
    if (filter === "order") return p.orderQty > 0;
    if (filter === "noorder") return p.notOrderedFlag;
    return p.status === filter;
  });
  const order: Record<Status, number> = { critical: 0, low: 1, ok: 2, setup: 3 };
  shown.sort((a, b) => order[a.status] - order[b.status] || (a.daysOfCover ?? 999) - (b.daysOfCover ?? 999));

  return (
    <>
      <TopBar
        title="Items"
        sub={`${plans.length} active SKUs`}
        right={
          <button className="btn sm" onClick={() => setAdding(!adding)}>
            <Icon name="plus" /> Add
          </button>
        }
      />
      {adding && (
        <AddItem
          onDone={() => {
            setAdding(false);
            refresh();
            toast("Item added");
          }}
        />
      )}
      <input className="input" placeholder="Search name, SKU or supplier" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
      <div className="tabs">
        {(
          [
            ["all", "All"],
            ["critical", "Critical"],
            ["low", "Low"],
            ["ok", "OK"],
            ["setup", "Setup needed"],
            ["order", "To order"],
            ["noorder", "Not ordered 30d+"],
          ] as [Filter, string][]
        ).map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
            {l} ({counts[k] ?? 0})
          </button>
        ))}
      </div>
      <div className="list">
        {shown.map((p) => (
          <a key={p.sku} className={`li ${p.status === "critical" ? "flag-red" : p.status === "low" ? "flag-amber" : ""}`} href={`#/items/${encodeURIComponent(p.sku)}`}>
            <span className={`dot ${p.status}`} />
            <div className="grow">
              <div className="name">{p.name}</div>
              <div className="meta">
                {p.sku} · {p.daysOfCover != null ? `${fmt(p.daysOfCover, 1)} d cover` : p.statusReason}
                {p.orderQty > 0 ? ` · order ${p.orderQty}` : ""}
              </div>
            </div>
            <div className="qty">
              {fmt(p.stock)}
              <div className="tiny muted" style={{ fontWeight: 500 }}>{unitLabel(p.unit)}</div>
            </div>
          </a>
        ))}
        {shown.length === 0 && <div className="empty">No items match.</div>}
      </div>
    </>
  );
}

function AddItem({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ sku: "", name: "", supplier: "", packSize: "", maxHolding: "", avgDaily: "" });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/items", {
        sku: f.sku,
        name: f.name,
        supplier: f.supplier || null,
        packSize: f.packSize ? Number(f.packSize) : null,
        maxHolding: f.maxHolding ? Number(f.maxHolding) : null,
        avgDaily: f.avgDaily ? Number(f.avgDaily) : null,
      });
      onDone();
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };
  const field = (k: keyof typeof f, label: string, numeric = false) => (
    <label className="field">
      <span>{label}</span>
      <input className="input" inputMode={numeric ? "decimal" : undefined} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  return (
    <form className="card" onSubmit={save}>
      <h2>New item</h2>
      {field("sku", "SKU")}
      {field("name", "Item name")}
      {field("supplier", "Supplier")}
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        {field("packSize", "Pcs / carton", true)}
        {field("maxHolding", "Max holding", true)}
        {field("avgDaily", "Avg daily use", true)}
      </div>
      <button className="btn primary block">Add item</button>
    </form>
  );
}

interface History {
  item: Item;
  plan: ItemPlan | null;
  counts: { date: string; qty: number; ocr_qty: number | null; source: string; created_at: string }[];
  deliveries: { date: string; qty: number; ordered_qty: number | null; shortage: number | null; created_at: string }[];
  orders: { id: number; order_date: string; expected: string; qty: number; received: number; closed: number }[];
  forecast: { date: string; qty: number }[];
  audit: { id: number; ts: string; actor: string; action: string; field: string | null; old_value: string | null; new_value: string | null; note: string | null }[];
}

export function ItemDetail({ sku }: { sku: string }) {
  const { dash, refresh } = useDash();
  const { data, error, reload } = useLoad<History>(`/items/${encodeURIComponent(sku)}/history?days=45`, [sku]);
  const [tab, setTab] = useState<"history" | "settings" | "audit">("history");
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const { item, plan } = data;
  const today = dash!.today;
  const from = addDays(today, -14);
  const to = addDays(today, 10);

  // Last count of each day, plus a projection from today using forecast/average usage.
  const byDay = new Map<string, number>();
  for (const c of data.counts) if (c.date >= from) byDay.set(c.date, c.qty);
  const points: StockPoint[] = [...byDay.entries()].sort().map(([date, qty]) => ({ date, qty, kind: "count" }));
  if (plan?.stock != null && (plan.avgDaily != null || data.forecast.length)) {
    const fc = new Map(data.forecast.map((f) => [f.date, f.qty]));
    let s = plan.stock;
    points.push({ date: today, qty: s, kind: "projected" });
    for (let d = today; d < to; d = addDays(d, 1)) {
      const u = fc.get(d) ?? (isSunday(d) && !dash!.settings.sundayUsage ? 0 : plan.avgDaily ?? 0);
      s = Math.max(0, s - u);
      points.push({ date: addDays(d, 1), qty: s, kind: "projected" });
      if (s === 0) break;
    }
  }
  const events: EventMark[] = [
    ...data.orders.filter((o) => o.order_date >= from).map((o) => ({ date: o.order_date, label: `Ordered ${fmt(o.qty)}`, kind: "order" as const })),
    ...data.deliveries.filter((d) => d.date >= from).map((d) => ({ date: d.date, label: `Delivered ${fmt(d.qty)}`, kind: "delivery" as const })),
  ];
  const usage = data.forecast.filter((f) => f.date >= today).slice(0, 14);

  return (
    <>
      <Back to="#/items" label="Items" />
      <TopBar title={item.name} sub={`${item.sku}${item.supplier ? ` · ${item.supplier}` : ""}`} right={plan && <StatusPill status={plan.status} />} />
      {plan && (
        <div className="grid kpi" style={{ marginBottom: 14 }}>
          <div className="kpi-tile">
            <div className="n">{fmt(plan.stock)}</div>
            <div className="l">Stock ({unitLabel(item.unit)})</div>
          </div>
          <div className={`kpi-tile ${plan.status === "critical" ? "red" : plan.status === "low" ? "amber" : ""}`}>
            <div className="n">{fmt(plan.daysOfCover, 1)}</div>
            <div className="l">Days of cover</div>
          </div>
          <div className="kpi-tile">
            <div className="n">{fmt(plan.avgDaily, 1)}</div>
            <div className="l">Avg use / day</div>
          </div>
          <div className="kpi-tile green">
            <div className="n">{fmt(plan.orderQty)}</div>
            <div className="l">To order</div>
          </div>
        </div>
      )}
      {plan?.depletion && (
        <div className={`card ${plan.depletion.severity === "soon" ? "warn" : "danger"}`}>
          <strong>Runs out {day(plan.depletion.depletionDate)}</strong>
          <div className="small">
            {plan.depletion.message}. Last order that arrives in time: {day(plan.depletion.latestOrderDate)} before {dash!.settings.cutoff}.
          </div>
        </div>
      )}
      <div className="tabs">
        {(["history", "settings", "audit"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "history" ? "History" : t === "settings" ? "Item settings" : "Changes"}
          </button>
        ))}
      </div>
      {tab === "history" && (
        <>
          <div className="card">
            <h2>Stock level</h2>
            {points.length ? <StockChart points={points} events={events} safety={plan?.safetyStock ?? null} from={from} to={to} /> : <div className="empty small">No counts yet.</div>}
          </div>
          <div className="card">
            <h2>Forecast usage per day</h2>
            <UsageBars data={usage} />
          </div>
          <div className="card">
            <h2>Counts, deliveries &amp; orders</h2>
            <div className="scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Event</th>
                    <th className="n">Qty</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...data.counts.map((c) => ({ date: c.date, ts: c.created_at, ev: "Count", qty: c.qty, detail: c.source === "ocr-corrected" ? `OCR read ${c.ocr_qty}, corrected` : c.source })),
                    ...data.deliveries.map((d) => ({ date: d.date, ts: d.created_at, ev: "Delivery", qty: d.qty, detail: d.shortage ? `short ${fmt(d.shortage)} of ${fmt(d.ordered_qty)}` : d.ordered_qty ? "as ordered" : "no open order" })),
                    ...data.orders.map((o) => ({ date: o.order_date, ts: o.order_date, ev: `Order #${o.id}`, qty: o.qty, detail: `due ${day(o.expected, false)} · received ${fmt(o.received)}${o.closed && o.received < o.qty ? " · closed" : ""}` })),
                  ]
                    .sort((a, b) => (b.date + b.ts).localeCompare(a.date + a.ts))
                    .map((r, i) => (
                      <tr key={i}>
                        <td>{day(r.date, false)}</td>
                        <td>{r.ev}</td>
                        <td className="n">{fmt(r.qty, 2)}</td>
                        <td className="muted">{r.detail}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {tab === "settings" && (
        <ItemSettings
          item={item}
          onSaved={() => {
            reload();
            refresh();
          }}
        />
      )}
      {tab === "audit" && (
        <div className="list">
          {data.audit.length === 0 && <div className="empty">No changes recorded.</div>}
          {data.audit.map((a) => (
            <div key={a.id} className="li">
              <div className="grow">
                <div className="small">
                  <strong>{a.field ?? a.action}</strong> {a.old_value != null ? `${a.old_value} → ` : ""}
                  {a.new_value}
                </div>
                <div className="meta">
                  {a.actor} · {timeAgo(a.ts)} · {new Date(a.ts).toLocaleString()}
                  {a.note ? ` · ${a.note}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ItemSettings({ item, onSaved }: { item: Item; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: item.name,
    supplier: item.supplier ?? "",
    unit: item.unit,
    packSize: item.packSize?.toString() ?? "",
    minLevel: item.minLevel?.toString() ?? "",
    maxHolding: item.maxHolding?.toString() ?? "",
    avgDaily: item.avgDaily?.toString() ?? "",
    leadDays: item.leadDays?.toString() ?? "",
    active: item.active,
  });
  const [saving, setSaving] = useState(false);
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put(`/items/${encodeURIComponent(item.sku)}`, {
        name: f.name,
        supplier: f.supplier || null,
        unit: f.unit,
        packSize: num(f.packSize),
        minLevel: num(f.minLevel),
        maxHolding: num(f.maxHolding),
        avgDaily: num(f.avgDaily),
        leadDays: num(f.leadDays),
        active: f.active,
      });
      toast("Saved");
      onSaved();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setSaving(false);
    }
  };
  const field = (k: "packSize" | "minLevel" | "maxHolding" | "avgDaily" | "leadDays", label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input className="input" inputMode="decimal" value={f[k]} placeholder={hint} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  return (
    <form className="card" onSubmit={save}>
      <label className="field">
        <span>Name</span>
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label className="field">
        <span>Supplier</span>
        <input className="input" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} />
      </label>
      <label className="field">
        <span>Stock is counted and ordered in</span>
        <div className="seg">
          <button type="button" className={f.unit === "carton" ? "on" : ""} onClick={() => setF({ ...f, unit: "carton" })}>
            Cartons
          </button>
          <button type="button" className={f.unit === "piece" ? "on" : ""} onClick={() => setF({ ...f, unit: "piece" })}>
            Pieces
          </button>
        </div>
      </label>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {field("packSize", "Pieces per carton", "unknown")}
        {field("minLevel", `Minimum level (${unitLabel(f.unit)})`, "none")}
        {field("maxHolding", "Max holding", "none")}
        {field("avgDaily", "Fallback avg use / day", "none")}
        {field("leadDays", "Lead time (working days)", "default")}
      </div>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (shown on count sheet and order list)
      </label>
      <button className="btn primary block" disabled={saving} style={{ marginTop: 8 }}>
        {saving ? "Saving…" : "Save item"}
      </button>
    </form>
  );
}
