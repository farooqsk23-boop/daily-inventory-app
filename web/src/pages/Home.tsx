import { useMemo, useState } from "react";
import { isWorkingDay, nextWorkingDay } from "../../../shared/calendar.ts";
import type { ItemPlan } from "../../../shared/ordering.ts";
import { useDash } from "../App.tsx";
import { Countdown, Icon, StatusPill, TopBar, useCutoff } from "../ui.tsx";
import { day, fmt, unitLabel } from "../util.ts";

export function Home() {
  const { dash } = useDash();
  const d = dash!;
  const s = d.settings;
  const cut = useCutoff(s.timeZone, s.cutoff, (x) => isWorkingDay(x, s));
  const [coverAll, setCoverAll] = useState(false);

  const plans = d.plans;
  const critical = plans.filter((p) => p.status === "critical");
  const depletion = plans.filter((p) => p.depletion).sort((a, b) => (a.depletion!.latestOrderDate < b.depletion!.latestOrderDate ? -1 : 1));
  const notOrdered = plans.filter((p) => p.notOrderedFlag);
  const toOrder = plans.filter((p) => p.orderQty > 0);
  const countedToday = d.lastCount?.date === d.today;

  const cover = useMemo(
    () =>
      plans
        .filter((p) => p.daysOfCover != null || p.stock === 0)
        .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0)),
    [plans],
  );

  return (
    <>
      <TopBar
        title="Stockroom"
        sub={`${day(d.today)} · ${d.isWorkingDay ? "Warehouse open" : "Warehouse closed today"}`}
        right={
          <div className="brand-dot">
            <Icon name="box" size={18} />
          </div>
        }
      />

      <CutoffCard open={cut.open} secs={cut.secsLeft} cutoff={s.cutoff} toOrder={toOrder.length} today={cut.now.date} working={cut.working} holidays={s.holidays} />

      <div className="actions4">
        <a className="action" href="#/count">
          <Icon name="count" />
          Count
          <span className="done">{countedToday ? "✓ done" : "to do"}</span>
        </a>
        <a className="action" href="#/delivery">
          <Icon name="truck" />
          Delivery
          <span className="done">{d.lastDelivery?.date === d.today ? "✓ today" : d.overdueDeliveries ? `${d.overdueDeliveries} overdue` : "—"}</span>
        </a>
        <a className="action" href="#/usage">
          <Icon name="chart" />
          Usage
          <span className="done">{d.lastImport ? `to ${day(d.lastImport.to_date, false)}` : "none yet"}</span>
        </a>
        <a className="action" href="#/order">
          <Icon name="cart" />
          Order
          <span className="done">{toOrder.length} items</span>
        </a>
      </div>

      <div className="grid kpi" style={{ marginBottom: 14 }}>
        <a className="kpi-tile" href="#/items">
          <div className="n">{d.summary.totalSkus}</div>
          <div className="l">Total SKUs</div>
        </a>
        <a className="kpi-tile red" href="#/items?status=critical">
          <div className="n">{d.summary.critical}</div>
          <div className="l">Critical</div>
        </a>
        <a className="kpi-tile amber" href="#/items?status=low">
          <div className="n">{d.summary.low}</div>
          <div className="l">Low</div>
        </a>
        <a className="kpi-tile green" href="#/order">
          <div className="n">{d.summary.toOrder}</div>
          <div className="l">To order today</div>
        </a>
      </div>

      <Alerts
        countedToday={countedToday}
        critical={critical}
        depletion={depletion}
        notOrdered={notOrdered}
        notOrderedDays={s.notOrderedDays}
        overdue={d.overdueDeliveries}
        unmatched={d.unmatchedMappings}
        noForecast={!d.lastImport}
        setup={d.summary.setup}
      />

      <div className="card">
        <h2>
          Days of cover
          <span className="muted small">usage days, Sundays skipped</span>
        </h2>
        {cover.length === 0 ? (
          <div className="empty small">Count stock and import usage to see days of cover.</div>
        ) : (
          <div className="stack">
            {(coverAll ? cover : cover.slice(0, 10)).map((p) => (
              <CoverRow key={p.sku} p={p} />
            ))}
            {cover.length > 10 && (
              <button className="btn ghost sm" onClick={() => setCoverAll(!coverAll)}>
                {coverAll ? "Show fewer" : `Show all ${cover.length}`}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function CutoffCard({ open, secs, cutoff, toOrder, today, working, holidays }: { open: boolean; secs: number; cutoff: string; toOrder: number; today: string; working: boolean; holidays: string[] }) {
  if (open) {
    const urgent = secs < 3600;
    return (
      <a href="#/order" className={`card ${urgent ? "danger" : "green"}`} style={{ display: "block", textDecoration: "none" }}>
        <div className="row between nowrap">
          <div>
            <div className="small" style={{ fontWeight: 600, opacity: 0.9 }}>
              Order cutoff {cutoff} — time left
            </div>
            <Countdown secs={secs} />
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="big-num">{toOrder}</div>
            <div className="small">to order</div>
          </div>
        </div>
      </a>
    );
  }
  const next = nextWorkingDay(today, { holidays });
  return (
    <div className="card tint">
      <div className="row nowrap">
        <Icon name="clock" />
        <div>
          <strong>{working ? "Today's cutoff has passed" : "No ordering today (warehouse closed)"}</strong>
          <div className="small muted">
            Orders now are booked for {day(next)} before {cutoff}. {toOrder} item{toOrder === 1 ? "" : "s"} on the list.
          </div>
        </div>
      </div>
    </div>
  );
}

function Alerts(props: {
  countedToday: boolean;
  critical: ItemPlan[];
  depletion: ItemPlan[];
  notOrdered: ItemPlan[];
  notOrderedDays: number;
  overdue: number;
  unmatched: number;
  noForecast: boolean;
  setup: number;
}) {
  const [showNotOrdered, setShowNotOrdered] = useState(false);
  const rows = [];
  if (!props.countedToday)
    rows.push(
      <a key="count" className="li flag-amber" href="#/count">
        <Icon name="count" />
        <div className="grow">
          <div className="name">Today's count not done yet</div>
          <div className="meta">Stock levels are from the last count</div>
        </div>
      </a>,
    );
  for (const p of props.critical.slice(0, 6))
    rows.push(
      <a key={`c-${p.sku}`} className="li flag-red" href={`#/items/${encodeURIComponent(p.sku)}`}>
        <span className="dot critical" />
        <div className="grow">
          <div className="name">{p.name}</div>
          <div className="meta">
            {p.statusReason} · stock {fmt(p.stock)} {unitLabel(p.unit)}
          </div>
        </div>
        {p.orderQty > 0 && <span className="pill critical">order {p.orderQty}</span>}
      </a>,
    );
  if (props.critical.length > 6)
    rows.push(
      <a key="more-crit" className="li" href="#/items?status=critical">
        <span className="small muted">+{props.critical.length - 6} more critical items</span>
      </a>,
    );
  for (const p of props.depletion)
    rows.push(
      <a key={`d-${p.sku}`} className={`li ${p.depletion!.severity === "soon" ? "flag-amber" : "flag-red"}`} href={`#/items/${encodeURIComponent(p.sku)}`}>
        <Icon name="alert" />
        <div className="grow">
          <div className="name">{p.name}</div>
          <div className="meta">
            Runs out {day(p.depletion!.depletionDate)} · order by {day(p.depletion!.latestOrderDate)} · not ordered{" "}
            {p.daysSinceOrder == null ? "on record" : `for ${p.daysSinceOrder} days`}
          </div>
        </div>
      </a>,
    );
  if (props.overdue)
    rows.push(
      <a key="overdue" className="li flag-amber" href="#/reports">
        <Icon name="truck" />
        <div className="grow">
          <div className="name">{props.overdue} ordered line{props.overdue === 1 ? "" : "s"} overdue</div>
          <div className="meta">Expected delivery date has passed</div>
        </div>
      </a>,
    );
  if (props.unmatched)
    rows.push(
      <a key="unmatched" className="li flag-amber" href="#/mapping">
        <Icon name="link" />
        <div className="grow">
          <div className="name">{props.unmatched} unmatched item name{props.unmatched === 1 ? "" : "s"}</div>
          <div className="meta">Match them to a SKU so their usage counts</div>
        </div>
      </a>,
    );
  if (props.noForecast)
    rows.push(
      <a key="nofc" className="li" href="#/usage">
        <Icon name="chart" />
        <div className="grow">
          <div className="name">No usage forecast imported</div>
          <div className="meta">Order quantities use the average daily usage from the master sheet</div>
        </div>
      </a>,
    );
  if (props.notOrdered.length)
    rows.push(
      <div key="no">
        <button className="li" style={{ width: "100%", border: 0, background: "none", textAlign: "left", cursor: "pointer", borderTop: rows.length ? "1px solid var(--line)" : 0 }} onClick={() => setShowNotOrdered(!showNotOrdered)}>
          <Icon name="history" />
          <div className="grow">
            <div className="name">
              {props.notOrdered.length} item{props.notOrdered.length === 1 ? "" : "s"} not ordered in {props.notOrderedDays}+ days
            </div>
            <div className="meta">Tap to {showNotOrdered ? "hide" : "show"} — depletion is checked for these</div>
          </div>
        </button>
        {showNotOrdered &&
          props.notOrdered.map((p) => (
            <a key={p.sku} className="li" href={`#/items/${encodeURIComponent(p.sku)}`} style={{ paddingLeft: 48 }}>
              <div className="grow">
                <div className="small" style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="meta">
                  {p.lastOrderDate ? `Last ordered ${day(p.lastOrderDate)} (${p.daysSinceOrder} d)` : "No order on record"}
                  {p.depletionDate ? ` · runs out ${day(p.depletionDate)}` : ""}
                </div>
              </div>
              <StatusPill status={p.status} />
            </a>
          ))}
      </div>,
    );

  return (
    <div className="card">
      <h2>
        Alerts
        {rows.length === 0 && <span className="pill ok">All clear</span>}
      </h2>
      {rows.length > 0 ? <div className="list">{rows}</div> : <div className="small muted">No warnings right now.</div>}
    </div>
  );
}

function CoverRow({ p }: { p: ItemPlan }) {
  const c = p.daysOfCover ?? 0;
  const pct = Math.min(100, (c / 10) * 100);
  return (
    <a href={`#/items/${encodeURIComponent(p.sku)}`} style={{ display: "block", textDecoration: "none", color: "inherit" }}>
      <div className="row between nowrap small" style={{ marginBottom: 4 }}>
        <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
          {p.name}
        </span>
        <strong style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(c, 1)} d</strong>
      </div>
      <div className={`bar ${p.status}`}>
        <div style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </a>
  );
}
