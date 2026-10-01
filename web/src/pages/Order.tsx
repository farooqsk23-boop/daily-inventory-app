import { useEffect, useMemo, useState } from "react";
import { isWorkingDay } from "../../../shared/calendar.ts";
import type { ItemPlan } from "../../../shared/ordering.ts";
import { api, download, saveBlob, type OrderLog } from "../api.ts";
import { useDash } from "../App.tsx";
import { Icon, StatusPill, TopBar, errMsg, useCutoff, useLoad, useToast } from "../ui.tsx";
import { copyText, day, fmt, unitLabel } from "../util.ts";

const SOURCE_TEXT = { forecast: "forecast", master: "master average", history: "observed usage", none: "no usage data" } as const;

export function Order() {
  const { dash, refresh } = useDash();
  const toast = useToast();
  const d = dash!;
  const s = d.settings;
  const cut = useCutoff(s.timeZone, s.cutoff, (x) => isWorkingDay(x, s));
  const log = useLoad<OrderLog[]>("/orders?limit=30");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<"list" | "log">("list");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const q: Record<string, string> = {};
    for (const p of d.plans) if (p.orderQty > 0) q[p.sku] = String(p.orderQty);
    setQty(q);
  }, [d.plans]);

  const w = d.plans[0]?.window;
  const lines = d.plans.filter((p) => Number(qty[p.sku]) > 0);
  const shown = (showAll ? d.plans : d.plans.filter((p) => p.orderQty > 0 || Number(qty[p.sku]) > 0))
    .slice()
    .sort((a, b) => (a.supplier ?? "~").localeCompare(b.supplier ?? "~") || a.name.localeCompare(b.name));
  const groups = useMemo(() => {
    const m = new Map<string, ItemPlan[]>();
    for (const p of shown) m.set(p.supplier ?? "No supplier", [...(m.get(p.supplier ?? "No supplier") ?? []), p]);
    return [...m.entries()];
  }, [shown]);

  const orderText = () => {
    const bySupplier = new Map<string, ItemPlan[]>();
    for (const p of lines) bySupplier.set(p.supplier ?? "No supplier", [...(bySupplier.get(p.supplier ?? "No supplier") ?? []), p]);
    const parts = [`Warehouse Request — ${day(w?.orderDate)}`, `Delivery: ${day(w?.firstDelivery)}`, ""];
    for (const [sup, ps] of bySupplier) {
      parts.push(`*${sup}*`);
      for (const p of ps) parts.push(`• ${p.sku} | ${p.name} | Qty: ${qty[p.sku]} ${unitLabel(p.unit, Number(qty[p.sku])).toUpperCase()}`);
      parts.push("");
    }
    parts.push(`Total lines: ${lines.length}`);
    return parts.join("\n");
  };

  const copy = async () => toast((await copyText(orderText())) ? "Order copied — paste it into Slack, WhatsApp or email" : "Could not copy", "ok");
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: `Order ${w?.orderDate}`, text: orderText() });
      } catch {
        /* cancelled */
      }
    } else copy();
  };
  const excel = async () => {
    try {
      await download("/export/order.xlsx", `order-${w?.orderDate}.xlsx`, { lines: lines.map((p) => ({ sku: p.sku, qty: Number(qty[p.sku]) })) });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const pdf = async () => {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.setTextColor(30, 158, 90);
    doc.text("Warehouse Request", 14, 18);
    doc.setFontSize(10);
    doc.setTextColor(60);
    doc.text(`Order date ${day(w?.orderDate)} · delivery ${day(w?.firstDelivery)} · ${lines.length} lines`, 14, 25);
    autoTable(doc, {
      startY: 31,
      head: [["Supplier", "SKU", "Item", "Qty", "Unit"]],
      body: lines
        .slice()
        .sort((a, b) => (a.supplier ?? "").localeCompare(b.supplier ?? ""))
        .map((p) => [p.supplier ?? "", p.sku, p.name, qty[p.sku], unitLabel(p.unit, Number(qty[p.sku])).toUpperCase()]),
      headStyles: { fillColor: [30, 158, 90] },
      styles: { fontSize: 8.5, cellPadding: 2 },
      columnStyles: { 3: { halign: "right", fontStyle: "bold" } },
    });
    saveBlob(doc.output("blob"), `order-${w?.orderDate}.pdf`);
  };

  const markOrdered = async () => {
    if (!lines.length) return;
    if (!confirm(`Record ${lines.length} line(s) as ordered on ${day(w?.orderDate)}?\nExpected delivery ${day(w?.firstDelivery)}.`)) return;
    setSaving(true);
    try {
      await api.post("/orders", { lines: lines.map((p) => ({ sku: p.sku, qty: Number(qty[p.sku]) })) });
      toast("Order recorded");
      refresh();
      log.reload();
      setTab("log");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const orderedToday = (log.data ?? []).some((o) => o.order_date === w?.orderDate);

  return (
    <div className="has-sticky">
      <TopBar
        title="Order list"
        sub={
          <>
            For {day(w?.orderDate)} → delivered {day(w?.firstDelivery)}
            {cut.open ? ` · cutoff in ${Math.floor(cut.secsLeft / 3600)}h ${Math.floor((cut.secsLeft % 3600) / 60)}m` : ""}
          </>
        }
      />
      <div className="tabs">
        <button className={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>
          To order ({lines.length})
        </button>
        <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>
          Order log
        </button>
      </div>

      {tab === "log" ? (
        <Log log={log.data} reload={() => { log.reload(); refresh(); }} />
      ) : (
        <>
          {orderedToday && <div className="card tint small">An order is already recorded for {day(w?.orderDate)}. Quantities below already count it as incoming.</div>}
          <div className="row" style={{ marginBottom: 12 }}>
            <button className="btn sm" onClick={copy} disabled={!lines.length}>
              <Icon name="copy" /> Copy
            </button>
            <button className="btn sm" onClick={share} disabled={!lines.length}>
              <Icon name="share" /> Send
            </button>
            <button className="btn sm" onClick={excel} disabled={!lines.length}>
              <Icon name="excel" /> Excel
            </button>
            <button className="btn sm" onClick={pdf} disabled={!lines.length}>
              <Icon name="pdf" /> PDF
            </button>
          </div>
          <label className="check small">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all items (to add something manually)
          </label>
          {shown.length === 0 ? (
            <div className="card empty">Nothing needs ordering right now.</div>
          ) : (
            <div className="list" style={{ marginTop: 8 }}>
              {groups.map(([sup, ps]) => (
                <div key={sup}>
                  <div className="group-h">{sup}</div>
                  {ps.map((p) => (
                    <div key={p.sku}>
                      <div className={`li ${p.status === "critical" ? "flag-red" : p.status === "low" ? "flag-amber" : ""}`}>
                        <span className={`dot ${p.status}`} />
                        <button className="grow" style={{ border: 0, background: "none", textAlign: "left", padding: 0, cursor: "pointer" }} onClick={() => setOpen(open === p.sku ? null : p.sku)}>
                          <div className="name">{p.name}</div>
                          <div className="meta">
                            {p.sku} · stock {fmt(p.stock)} · {p.daysOfCover != null ? `${fmt(p.daysOfCover, 1)} d cover` : "no usage"} · why?
                          </div>
                        </button>
                        <div style={{ textAlign: "center" }}>
                          <input
                            className={`num-input ${qty[p.sku] != null && Number(qty[p.sku]) !== p.orderQty ? "changed" : ""}`}
                            inputMode="numeric"
                            value={qty[p.sku] ?? ""}
                            placeholder="0"
                            aria-label={`Order quantity for ${p.name}`}
                            onChange={(e) => setQty({ ...qty, [p.sku]: e.target.value.replace(/[^\d.]/g, "") })}
                          />
                          <div className="tiny muted">{unitLabel(p.unit)}</div>
                        </div>
                      </div>
                      {open === p.sku && <Why p={p} safety={s.safetyMultiplier} />}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="sticky-bar">
            <div className="inner">
              <div className="grow small">
                <strong>{lines.length}</strong> lines
              </div>
              <button className="btn primary" disabled={!lines.length || saving} onClick={markOrdered}>
                <Icon name="check" /> {saving ? "Saving…" : "Mark as ordered"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Why({ p, safety }: { p: ItemPlan; safety: number }) {
  const floorIsMin = p.minLevel != null && p.minLevel > p.safetyStock;
  const u = unitLabel(p.unit);
  return (
    <div style={{ padding: "4px 14px 14px 38px", background: "var(--bg-soft)" }} className="small">
      <table className="t">
        <tbody>
          <tr>
            <td>
              Usage until {day(p.window.secondDelivery)} (next delivery {day(p.window.firstDelivery, false)} + following cycle)
            </td>
            <td className="n">{fmt(p.usageUntilSecondDelivery, 1)}</td>
          </tr>
          <tr>
            <td>{floorIsMin ? "Minimum level (higher than safety stock)" : `Safety stock (${safety} × ${fmt(p.avgDaily, 2)} ${u}/day avg)`}</td>
            <td className="n">+ {fmt(floorIsMin ? p.minLevel : p.safetyStock, 1)}</td>
          </tr>
          <tr>
            <td>Current stock</td>
            <td className="n">− {fmt(p.stock)}</td>
          </tr>
          {p.incoming > 0 && (
            <tr>
              <td>Confirmed incoming</td>
              <td className="n">− {fmt(p.incoming)}</td>
            </tr>
          )}
          <tr>
            <td>
              <strong>Order</strong> {p.packSize && p.unit === "piece" ? `(rounded up to packs of ${p.packSize})` : "(rounded up to whole cartons)"}
            </td>
            <td className="n">
              <strong>{fmt(p.orderQty)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 6, gap: 6 }}>
        <StatusPill status={p.status} />
        <span className="muted">
          {p.statusReason} · usage from {SOURCE_TEXT[p.usageSource]}
          {p.orderPieces ? ` · ${fmt(p.orderPieces)} pcs` : ""}
        </span>
      </div>
      {p.overMaxHolding && <div style={{ color: "#92400e", marginTop: 4 }}>Above max holding capacity ({fmt(p.maxHolding)}).</div>}
    </div>
  );
}

function Log({ log, reload }: { log: OrderLog[] | null; reload: () => void }) {
  const toast = useToast();
  if (!log) return null;
  if (!log.length) return <div className="card empty">No orders recorded yet. Use “Mark as ordered” on the order list.</div>;
  const remove = async (o: OrderLog) => {
    if (!confirm(`Delete order #${o.id}? Use this only for an order recorded by mistake.`)) return;
    try {
      await api.del(`/orders/${o.id}`);
      reload();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const close = async (lineId: number) => {
    if (!confirm("Close this line? The rest will no longer be expected.")) return;
    await api.put(`/orders/lines/${lineId}`, { closed: true });
    reload();
  };
  return (
    <>
      {log.map((o) => (
        <div key={o.id} className="card">
          <h2>
            <span>
              #{o.id} · {day(o.order_date)}
            </span>
            <span className="muted small">due {day(o.expected_delivery, false)}</span>
          </h2>
          <div className="list">
            {o.lines.map((l) => {
              const state = l.received >= l.qty ? "delivered" : l.closed ? (l.received ? "short-closed" : "cancelled") : l.received ? "partial" : "open";
              return (
                <div key={l.id} className="li">
                  <div className="grow">
                    <div className="name small">{l.name}</div>
                    <div className="meta">
                      {l.sku} · received {fmt(l.received)} of {fmt(l.qty)}
                    </div>
                  </div>
                  <span className={`pill ${state === "delivered" ? "ok" : state === "open" ? "info" : state === "partial" ? "low" : "critical"}`}>{state.replace("-", " ")}</span>
                  {!l.closed && l.received < l.qty && (
                    <button className="btn sm ghost" onClick={() => close(l.id)} aria-label="Close line">
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {o.lines.every((l) => l.received === 0) && (
            <button className="btn sm danger" style={{ marginTop: 10 }} onClick={() => remove(o)}>
              <Icon name="trash" /> Delete order
            </button>
          )}
        </div>
      ))}
    </>
  );
}
