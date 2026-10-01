import { useState } from "react";
import { Loading, TopBar, useLoad } from "../ui.tsx";

interface Row {
  id: number;
  ts: string;
  actor: string;
  action: string;
  entity: string;
  sku: string | null;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  note: string | null;
}

export function Audit() {
  const [limit, setLimit] = useState(200);
  const { data } = useLoad<Row[]>(`/audit?limit=${limit}`, [limit]);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  if (!data) return <Loading />;
  const actions = ["all", ...new Set(data.map((r) => r.action))];
  const rows = data.filter(
    (r) => (action === "all" || r.action === action) && (!q || `${r.actor} ${r.sku} ${r.field} ${r.note} ${r.new_value}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <>
      <TopBar title="Audit trail" sub="Who or what changed each number, and when" />
      <input className="input" placeholder="Search SKU, person, note…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
      <div className="tabs">
        {actions.map((a) => (
          <button key={a} className={action === a ? "on" : ""} onClick={() => setAction(a)}>
            {a}
          </button>
        ))}
      </div>
      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="li">
            <div className="grow">
              <div className="small">
                <strong>{r.action}</strong> {r.entity}
                {r.sku && (
                  <>
                    {" "}
                    · <a href={`#/items/${encodeURIComponent(r.sku)}`}>{r.sku}</a>
                  </>
                )}
                {r.field && ` · ${r.field}`}
                {(r.old_value != null || r.new_value != null) && (
                  <>
                    {": "}
                    {r.old_value != null && <span className="muted">{r.old_value} → </span>}
                    <strong>{r.new_value ?? "—"}</strong>
                  </>
                )}
              </div>
              <div className="meta">
                {r.actor} · {new Date(r.ts).toLocaleString()}
                {r.note ? ` · ${r.note}` : ""}
              </div>
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="empty">No entries.</div>}
      </div>
      {data.length >= limit && (
        <button className="btn block" style={{ marginTop: 12 }} onClick={() => setLimit(limit + 300)}>
          Load more
        </button>
      )}
    </>
  );
}
