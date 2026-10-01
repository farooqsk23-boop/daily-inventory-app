// Small dependency-free SVG charts for the item history page.
// One y-axis per chart; marks are thin; hover/tap shows a tooltip.
import { useMemo, useRef, useState } from "react";
import { addDays, diffDays, isSunday, type ISODate } from "../../shared/calendar.ts";
import { day, fmt } from "./util.ts";

const W = 400;
const H = 200;
const PAD = { l: 34, r: 8, t: 10, b: 24 };
const INK_MUTED = "#6b7280";
const GRID = "#eef0f2";
const GREEN = "#1e9e5a";
const GREEN_SOFT = "#8ccfa8";
const AMBER = "#d97706";

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export interface StockPoint {
  date: ISODate;
  qty: number;
  kind: "count" | "projected";
}

export interface EventMark {
  date: ISODate;
  label: string;
  kind: "order" | "delivery";
}

export function StockChart({ points, events, safety, from, to }: { points: StockPoint[]; events: EventMark[]; safety: number | null; from: ISODate; to: ISODate }) {
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const span = Math.max(1, diffDays(from, to));
  const max = niceMax(Math.max(1, ...points.map((p) => p.qty), safety ?? 0) * 1.1);
  const x = (d: ISODate) => PAD.l + (diffDays(from, d) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - Math.max(0, v) / max) * (H - PAD.t - PAD.b);
  const actual = points.filter((p) => p.kind === "count");
  const projected = points.filter((p) => p.kind === "projected");
  const path = (ps: StockPoint[]) => ps.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.qty).toFixed(1)}`).join("");
  const days = useMemo(() => Array.from({ length: span + 1 }, (_, i) => addDays(from, i)), [from, span]);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(span / 6);

  const onMove = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * span);
    setHover(Math.max(0, Math.min(span, i)));
  };
  const hd = hover != null ? days[hover] : null;
  const hp = hd ? points.find((p) => p.date === hd) : null;
  const he = hd ? events.filter((e) => e.date === hd) : [];

  return (
    <div style={{ position: "relative" }}>
      <div className="row small muted" style={{ gap: 14, marginBottom: 6 }}>
        <span className="row" style={{ gap: 6 }}>
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={GREEN} strokeWidth="2" /></svg>Counted stock
        </span>
        <span className="row" style={{ gap: 6 }}>
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={GREEN_SOFT} strokeWidth="2" strokeDasharray="4 3" /></svg>Projected
        </span>
        {safety != null && safety > 0 && (
          <span className="row" style={{ gap: 6 }}>
            <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={AMBER} strokeWidth="1" /></svg>Safety stock
          </span>
        )}
      </div>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Stock level over time" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: "pan-y", display: "block" }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={GRID} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill={INK_MUTED}>
              {fmt(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) =>
          isSunday(d) ? <rect key={d} x={x(d) - (W - PAD.l - PAD.r) / span / 2} y={PAD.t} width={(W - PAD.l - PAD.r) / span} height={H - PAD.t - PAD.b} fill="#f7f9f8" /> : i % labelEvery === 0 ? (
            <text key={d} x={x(d)} y={H - 8} textAnchor="middle" fontSize="11" fill={INK_MUTED}>
              {day(d, false)}
            </text>
          ) : null,
        )}
        {safety != null && safety > 0 && <line x1={PAD.l} x2={W - PAD.r} y1={y(safety)} y2={y(safety)} stroke={AMBER} strokeWidth="1" />}
        {projected.length > 1 && <path d={path(projected)} fill="none" stroke={GREEN_SOFT} strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />}
        {actual.length > 1 && <path d={path(actual)} fill="none" stroke={GREEN} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {actual.map((p) => (
          <circle key={p.date} cx={x(p.date)} cy={y(p.qty)} r="4" fill={GREEN} stroke="#fff" strokeWidth="2" />
        ))}
        {events.map((e, i) => (
          <path key={i} d={`M${x(e.date)},${H - PAD.b + 2} l-4,7 h8z`} fill={e.kind === "order" ? INK_MUTED : GREEN} />
        ))}
        {hd && (
          <line x1={x(hd)} x2={x(hd)} y1={PAD.t} y2={H - PAD.b} stroke="#c4c9cf" />
        )}
      </svg>
      {hd && (
        <div className="small" style={{ position: "absolute", top: 24, left: `${Math.min(70, (x(hd) / W) * 100)}%`, background: "#fff", border: "1px solid var(--line)", borderRadius: 10, padding: "6px 10px", boxShadow: "var(--shadow)", pointerEvents: "none", minWidth: 120 }}>
          <div className="muted tiny">{day(hd)}</div>
          {hp ? (
            <div>
              <strong>{fmt(hp.qty, 1)}</strong> <span className="muted">{hp.kind === "count" ? "counted" : "projected"}</span>
            </div>
          ) : (
            <div className="muted">no count</div>
          )}
          {he.map((e, i) => (
            <div key={i} className="tiny">
              {e.label}
            </div>
          ))}
        </div>
      )}
      <div className="tiny muted" style={{ marginTop: 4 }}>▲ green = delivery · ▲ grey = order · shaded = Sunday</div>
    </div>
  );
}

export function UsageBars({ data }: { data: { date: ISODate; qty: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <div className="empty small">No forecast usage imported for this item.</div>;
  const h = 140;
  const max = niceMax(Math.max(...data.map((d) => d.qty)) * 1.1);
  const band = (W - PAD.l - PAD.r) / data.length;
  const bw = Math.min(24, band - 2);
  const y = (v: number) => PAD.t + (1 - v / max) * (h - PAD.t - PAD.b);
  const base = h - PAD.b;
  const labelEvery = Math.ceil(data.length / 7);
  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${h}`} width="100%" role="img" aria-label="Forecast daily usage" style={{ display: "block" }} onPointerLeave={() => setHover(null)}>
        {[0, max].map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={GRID} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill={INK_MUTED}>
              {fmt(t, 1)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = PAD.l + band * i + band / 2;
          const top = y(d.qty);
          const r = Math.min(4, (base - top) / 2, bw / 2);
          return (
            <g key={d.date} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
              <rect x={cx - band / 2} y={PAD.t} width={band} height={base - PAD.t} fill="transparent" />
              {d.qty > 0 && (
                <path
                  d={`M${cx - bw / 2},${base} V${top + r} q0,-${r} ${r},-${r} H${cx + bw / 2 - r} q${r},0 ${r},${r} V${base} Z`}
                  fill={hover === i ? "#157a44" : isSunday(d.date) ? GREEN_SOFT : GREEN}
                />
              )}
              {i % labelEvery === 0 && (
                <text x={cx} y={h - 8} textAnchor="middle" fontSize="11" fill={INK_MUTED}>
                  {day(d.date, false)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div className="small" style={{ position: "absolute", top: 0, left: `${Math.min(70, ((PAD.l + band * hover) / W) * 100)}%`, background: "#fff", border: "1px solid var(--line)", borderRadius: 10, padding: "6px 10px", boxShadow: "var(--shadow)", pointerEvents: "none" }}>
          <strong>{fmt(data[hover].qty, 2)}</strong> <span className="muted">· {day(data[hover].date)}</span>
        </div>
      )}
    </div>
  );
}
