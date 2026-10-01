import { useState } from "react";
import { download } from "../api.ts";
import { useDash } from "../App.tsx";
import { Icon, Loading, StatusPill, TopBar, errMsg, useLoad, useToast } from "../ui.tsx";
import { day, fmt } from "../util.ts";

interface Disc {
  date: string | null;
  rows: { sku: string; name: string; counted: number; prevDate: string | null; prevQty: number | null; deliveriesSince?: number; expected: number | null; gap: number | null; gapPct: number | null; flagged: boolean }[];
}
interface Deliv {
  recent: { date: string; sku: string; name: string; qty: number; ordered_qty: number | null; shortage: number | null; supplier: string | null; reference: string | null; unordered: boolean }[];
  overdue: { id: number; order_id: number; sku: string; name: string; outstanding: number; expected_delivery: string }[];
}

export function Reports() {
  const { dash } = useDash();
  const toast = useToast();
  const [tab, setTab] = useState<"disc" | "deliv" | "stale">("disc");
  const disc = useLoad<Disc>("/reports/discrepancies");
  const deliv = useLoad<Deliv>("/reports/deliveries?days=30");
  const d = dash!;
  const stale = d.plans.filter((p) => p.notOrderedFlag).sort((a, b) => (b.daysSinceOrder ?? 9999) - (a.daysSinceOrder ?? 9999));

  const dl = async (path: string, name: string) => {
    try {
      await download(path, name);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return (
    <>
      <TopBar title="Reports" />
      <div className="card">
        <h2>Export to Excel</h2>
        <div className="row">
          <button className="btn sm" onClick={() => dl("/export/stock.xlsx", `stock-${d.today}.xlsx`)}>
            <Icon name="excel" /> Stock sheet
          </button>
          <button className="btn sm" onClick={() => dl("/export/order.xlsx", `order-${d.today}.xlsx`)}>
            <Icon name="excel" /> Order list
          </button>
          <button className="btn sm primary" onClick={() => dl("/export/reports.xlsx", `stockroom-report-${d.today}.xlsx`)}>
            <Icon name="excel" /> Full report
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>The full report has stock, order list, alerts, discrepancies, delivery check, order log, count history and the audit trail.</div>
      </div>

      <div className="tabs">
        <button className={tab === "disc" ? "on" : ""} onClick={() => setTab("disc")}>
          Discrepancies
        </button>
        <button className={tab === "deliv" ? "on" : ""} onClick={() => setTab("deliv")}>
          Delivery check
        </button>
        <button className={tab === "stale" ? "on" : ""} onClick={() => setTab("stale")}>
          Not ordered {d.settings.notOrderedDays}d+ ({stale.length})
        </button>
      </div>

      {tab === "disc" &&
        (!disc.data ? (
          <Loading />
        ) : !disc.data.date ? (
          <div className="card empty">No counts yet.</div>
        ) : (
          <div className="card">
            <h2>
              Count {day(disc.data.date)}
              <span className="small muted">expected = last count + deliveries − forecast usage</span>
            </h2>
            <div className="scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="n">Expected</th>
                    <th className="n">Counted</th>
                    <th className="n">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {disc.data.rows
                    .filter((r) => r.expected != null)
                    .sort((a, b) => Number(b.flagged) - Number(a.flagged) || Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0))
                    .map((r) => (
                      <tr key={r.sku} style={r.flagged ? { background: "var(--amber-tint)" } : undefined}>
                        <td>
                          <a href={`#/items/${encodeURIComponent(r.sku)}`}>{r.name}</a>
                          <div className="tiny muted">
                            prev {fmt(r.prevQty)} on {day(r.prevDate, false)}
                            {r.deliveriesSince ? ` · +${fmt(r.deliveriesSince)} delivered` : ""}
                          </div>
                        </td>
                        <td className="n">{fmt(r.expected, 1)}</td>
                        <td className="n">{fmt(r.counted)}</td>
                        <td className="n" style={{ fontWeight: r.flagged ? 700 : 400, color: r.flagged ? "#92400e" : undefined }}>
                          {(r.gap ?? 0) > 0 ? "+" : ""}
                          {fmt(r.gap, 1)}
                          {r.gapPct != null && <div className="tiny">{fmt(r.gapPct, 0)}%</div>}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {disc.data.rows.every((r) => r.expected == null) && <div className="empty small">Needs two counts on different days to compare.</div>}
            <div className="tiny muted" style={{ marginTop: 8 }}>
              Highlighted gaps are at least {d.settings.discrepancyMin} units and {d.settings.discrepancyPct}% — check for wastage, unrecorded issues or counting errors.
            </div>
          </div>
        ))}

      {tab === "deliv" &&
        (!deliv.data ? (
          <Loading />
        ) : (
          <>
            {deliv.data.overdue.length > 0 && (
              <div className="card danger">
                <h2>Overdue — not delivered</h2>
                <div className="list">
                  {deliv.data.overdue.map((o) => (
                    <div key={o.id} className="li">
                      <div className="grow">
                        <div className="name small">{o.name}</div>
                        <div className="meta">
                          Order #{o.order_id} · due {day(o.expected_delivery)}
                        </div>
                      </div>
                      <div className="qty">{fmt(o.outstanding)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="card">
              <h2>Last 30 days</h2>
              {deliv.data.recent.length === 0 ? (
                <div className="empty small">No deliveries recorded.</div>
              ) : (
                <div className="scroll-x">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Item</th>
                        <th className="n">Ordered</th>
                        <th className="n">Delivered</th>
                        <th>Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliv.data.recent.map((r, i) => (
                        <tr key={i} style={r.shortage ? { background: "var(--red-tint)" } : undefined}>
                          <td>{day(r.date, false)}</td>
                          <td>
                            {r.name}
                            <div className="tiny muted">
                              {r.supplier ?? ""}
                              {r.reference ? ` · ${r.reference}` : ""}
                            </div>
                          </td>
                          <td className="n">{fmt(r.ordered_qty)}</td>
                          <td className="n">{fmt(r.qty)}</td>
                          <td>{r.shortage ? <span className="pill critical">short {fmt(r.shortage)}</span> : r.unordered ? <span className="pill low">unordered</span> : <span className="pill ok">ok</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ))}

      {tab === "stale" && (
        <div className="list">
          {stale.map((p) => (
            <a key={p.sku} className={`li ${p.depletion ? "flag-red" : ""}`} href={`#/items/${encodeURIComponent(p.sku)}`}>
              <div className="grow">
                <div className="name">{p.name}</div>
                <div className="meta">
                  {p.lastOrderDate ? `Last ordered ${day(p.lastOrderDate)} · ${p.daysSinceOrder} days ago` : "No order on record"}
                  {p.depletion ? ` · runs out ${day(p.depletion.depletionDate)}, order by ${day(p.depletion.latestOrderDate)}` : p.depletionDate ? ` · runs out ${day(p.depletionDate)}` : ""}
                </div>
              </div>
              <StatusPill status={p.status} />
            </a>
          ))}
          {stale.length === 0 && <div className="empty">Every item has been ordered recently.</div>}
        </div>
      )}
    </>
  );
}
