import { useState } from "react";
import { api, type Item, type MatchResult } from "../api.ts";
import { useDash } from "../App.tsx";
import { Conf, SkuSelect, TopBar, errMsg, useLoad, useToast, Loading } from "../ui.tsx";
import { timeAgo } from "../util.ts";

interface Mapping {
  source_key: string;
  context: "usage" | "delivery";
  source_name: string;
  sku: string | null;
  confidence: number | null;
  status: "confirmed" | "auto" | "unmatched" | "ignored";
  updated_at: string;
}

type Filter = "unmatched" | "auto" | "confirmed" | "ignored" | "all";

export function Mappings() {
  const { refresh } = useDash();
  const toast = useToast();
  const maps = useLoad<Mapping[]>("/mappings");
  const items = useLoad<Item[]>("/items");
  const [filter, setFilter] = useState<Filter>("unmatched");
  const [editing, setEditing] = useState<string | null>(null);
  const [sugg, setSugg] = useState<MatchResult | null>(null);

  if (!maps.data || !items.data) return <Loading />;
  const names = new Map(items.data.map((i) => [i.sku, i.name]));
  const count = (f: Filter) => (f === "all" ? maps.data!.length : maps.data!.filter((m) => m.status === f).length);
  const shown = filter === "all" ? maps.data : maps.data.filter((m) => m.status === filter);

  const save = async (m: Mapping, sku: string | null, status?: string) => {
    try {
      await api.put("/mappings", { context: m.context, sourceName: m.source_name, sku, status });
      setEditing(null);
      maps.reload();
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const startEdit = async (m: Mapping) => {
    const key = `${m.context}|${m.source_key}`;
    setEditing(key);
    setSugg(null);
    setSugg(await api.get<MatchResult>(`/mappings/suggest?name=${encodeURIComponent(m.source_name)}`));
  };

  return (
    <>
      <TopBar title="SKU matching" sub="How names on the usage file and delivery notes map to your SKUs" />
      <div className="tabs">
        {(
          [
            ["unmatched", "Unmatched"],
            ["auto", "Auto-matched"],
            ["confirmed", "Confirmed"],
            ["ignored", "Ignored"],
            ["all", "All"],
          ] as [Filter, string][]
        ).map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
            {l} ({count(k)})
          </button>
        ))}
      </div>
      {filter === "unmatched" && count("unmatched") > 0 && (
        <div className="card warn small">These names were found in an import but match no SKU. Their usage is not counted until you match them, or mark them ignored if you don't stock them.</div>
      )}
      {shown.length === 0 && <div className="card empty">Nothing here. Matches are saved when you import usage or confirm a delivery.</div>}
      <div className="stack">
        {shown.map((m) => {
          const key = `${m.context}|${m.source_key}`;
          return (
            <div key={key} className={`card ${m.status === "unmatched" ? "danger" : ""}`} style={{ marginBottom: 0 }}>
              <div className="row between nowrap">
                <div className="grow">
                  <strong>{m.source_name}</strong>
                  <div className="small muted">
                    {m.context === "usage" ? "Usage file" : "Delivery note"} · {timeAgo(m.updated_at)}
                  </div>
                </div>
                <Conf level={m.status === "confirmed" ? "exact" : m.status === "auto" ? "high" : m.status === "ignored" ? "medium" : "none"} />
              </div>
              {editing === key ? (
                <div style={{ marginTop: 10 }}>
                  <SkuSelect value={m.sku} items={items.data!} suggestions={sugg?.suggestions ?? []} onChange={(sku) => save(m, sku)} />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn sm" onClick={() => save(m, null, "ignored")}>
                      Ignore this name
                    </button>
                    <button className="btn sm ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row between" style={{ marginTop: 8 }}>
                  <div className="small">
                    {m.sku ? (
                      <>
                        → <strong>{names.get(m.sku) ?? m.sku}</strong> <span className="muted">({m.sku})</span>
                        {m.status === "auto" && m.confidence != null && <span className="muted"> · {Math.round(m.confidence * 100)}%</span>}
                      </>
                    ) : m.status === "ignored" ? (
                      <span className="muted">Ignored — not tracked</span>
                    ) : (
                      <span style={{ color: "var(--red)" }}>No SKU</span>
                    )}
                  </div>
                  <div className="row">
                    {m.status === "auto" && m.sku && (
                      <button className="btn sm primary" onClick={() => save(m, m.sku)}>
                        Confirm
                      </button>
                    )}
                    <button className="btn sm" onClick={() => startEdit(m)}>
                      {m.sku ? "Change" : "Match"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
