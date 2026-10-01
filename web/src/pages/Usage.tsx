import { useRef, useState } from "react";
import { api, type Item, type MatchResult } from "../api.ts";
import { useDash } from "../App.tsx";
import { Conf, Icon, Loading, SkuSelect, TopBar, errMsg, useLoad, useToast } from "../ui.tsx";
import { day, fmt } from "../util.ts";

interface ParsedRow {
  sourceName: string;
  code: string | null;
  days: Record<string, number>;
  match: MatchResult & { saved: boolean; ignored: boolean };
}
interface Parsed {
  filename: string;
  sheet: string;
  layout: string;
  from: string | null;
  to: string | null;
  rows: ParsedRow[];
  itemsWithoutUsage: { sku: string; name: string }[];
}
interface RowState {
  sku: string | null;
  confirmed: boolean;
  ignore: boolean;
}

export function Usage() {
  const { dash, refresh } = useDash();
  const toast = useToast();
  const items = useLoad<Item[]>("/items");
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [state, setState] = useState<Record<string, RowState>>({});
  const [unit, setUnit] = useState<"piece" | "carton">("piece");
  const [filter, setFilter] = useState<"review" | "all">("review");
  const [result, setResult] = useState<{ imported: number; warnings: string[] } | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const p = await api.post<Parsed>("/usage/parse", fd);
      setParsed(p);
      const st: Record<string, RowState> = {};
      for (const r of p.rows) {
        st[r.sourceName] = {
          sku: r.match.level === "none" ? null : r.match.sku,
          confirmed: r.match.saved || r.match.level === "exact" || r.match.level === "high",
          ignore: r.match.ignored,
        };
      }
      setState(st);
      setFilter("review");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const needsReview = (r: ParsedRow) => {
    const s = state[r.sourceName];
    return !s.ignore && (!s.sku || !s.confirmed);
  };

  const commit = async () => {
    if (!parsed) return;
    const pending = parsed.rows.filter((r) => state[r.sourceName].sku && !state[r.sourceName].confirmed && !state[r.sourceName].ignore);
    if (pending.length) return toast(`Confirm ${pending.length} uncertain match(es) first`, "error");
    const unmatched = parsed.rows.filter((r) => !state[r.sourceName].sku && !state[r.sourceName].ignore);
    if (unmatched.length && !confirm(`${unmatched.length} name(s) are unmatched. They will be flagged and their usage skipped. Continue?`)) return;
    setBusy(true);
    try {
      const r = await api.post<{ imported: number; warnings: string[] }>("/usage/commit", {
        filename: parsed.filename,
        unit,
        rows: parsed.rows.map((row) => {
          const s = state[row.sourceName];
          return {
            sourceName: row.sourceName,
            sku: s.ignore ? null : s.sku,
            ignore: s.ignore,
            // High-confidence matches accepted without a look are stored as "auto";
            // anything the controller confirmed or changed is stored as "confirmed".
            confirmed: row.match.saved || (s.confirmed && !(row.match.level === "high" && s.sku === row.match.sku)),
            confidence: row.match.confidence,
            days: row.days,
          };
        }),
      });
      setResult(r);
      setParsed(null);
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (busy) return <Loading label="Working…" />;

  if (!parsed)
    return (
      <>
        <TopBar title="Usage forecast" sub="Calo dashboard packaging stats (Excel)" />
        {result && (
          <div className="card tint">
            <strong>
              Imported usage for {result.imported} SKU{result.imported === 1 ? "" : "s"}
            </strong>
            {result.warnings.length > 0 && (
              <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18, color: "#92400e" }}>
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <a className="btn primary sm" href="#/order">
                See order list
              </a>
            </div>
          </div>
        )}
        <div className="card">
          {dash!.lastImport ? (
            <p className="small" style={{ marginTop: 0 }}>
              Current forecast: <strong>{day(dash!.lastImport.from_date)}</strong> to <strong>{day(dash!.lastImport.to_date)}</strong>
              {dash!.lastImport.to_date < dash!.today && <span className="pill critical" style={{ marginLeft: 6 }}>expired</span>}
            </p>
          ) : (
            <p className="small muted" style={{ marginTop: 0 }}>No forecast yet — order quantities use the master average usage.</p>
          )}
          <button className="btn primary block" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" /> Upload Excel file
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden onChange={(e) => upload(e.target.files?.[0])} />
          <p className="small muted" style={{ marginBottom: 0 }}>
            One row per packaging item with a column per date, or Date / Item / Quantity columns. Item names are matched to your SKUs automatically; you confirm uncertain ones once and they are remembered.
          </p>
        </div>
      </>
    );

  const reviewCount = parsed.rows.filter(needsReview).length;
  const rows = filter === "review" ? parsed.rows.filter(needsReview) : parsed.rows;
  const dayCount = parsed.from && parsed.to ? Object.keys(parsed.rows[0]?.days ?? {}).length : 0;

  return (
    <div className="has-sticky">
      <TopBar title="Check usage import" sub={`${parsed.filename} · ${day(parsed.from)} – ${day(parsed.to)} · ${parsed.rows.length} names`} />
      <div className="card">
        <div className="row between">
          <span className="small" style={{ fontWeight: 600 }}>Quantities in this file are</span>
          <div className="seg">
            <button className={unit === "piece" ? "on" : ""} onClick={() => setUnit("piece")}>
              Pieces
            </button>
            <button className={unit === "carton" ? "on" : ""} onClick={() => setUnit("carton")}>
              Cartons
            </button>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          {unit === "piece" ? "Converted to cartons using each item's pack size." : "Used as-is for items counted in cartons."}
        </div>
      </div>
      <div className="tabs">
        <button className={filter === "review" ? "on" : ""} onClick={() => setFilter("review")}>
          To review ({reviewCount})
        </button>
        <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
          All ({parsed.rows.length})
        </button>
      </div>
      {rows.length === 0 && <div className="card empty">All names are matched. Review “All” or import.</div>}
      {rows.map((r) => {
        const s = state[r.sourceName];
        const vals = Object.values(r.days);
        const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        const set = (patch: Partial<RowState>) => setState({ ...state, [r.sourceName]: { ...s, ...patch } });
        return (
          <div key={r.sourceName} className={`card ${s.ignore ? "" : !s.sku ? "danger" : !s.confirmed ? "warn" : ""}`} style={s.ignore ? { opacity: 0.6 } : undefined}>
            <div className="row between nowrap" style={{ marginBottom: 8 }}>
              <div className="grow">
                <strong>{r.sourceName}</strong>
                <div className="small muted">
                  avg {fmt(avg, 1)}/day over {vals.length} days{r.code ? ` · code ${r.code}` : ""}
                </div>
              </div>
              {!s.ignore && <Conf level={r.match.saved ? "exact" : s.sku ? r.match.level : "none"} />}
            </div>
            {!s.ignore && <SkuSelect value={s.sku} items={items.data ?? []} suggestions={r.match.suggestions} onChange={(sku) => set({ sku, confirmed: !!sku })} />}
            <div className="row" style={{ marginTop: 8 }}>
              {!s.ignore && s.sku && !s.confirmed && (
                <button className="btn sm primary" onClick={() => set({ confirmed: true })}>
                  <Icon name="check" /> Correct match
                </button>
              )}
              <label className="check small" style={{ minHeight: 0 }}>
                <input type="checkbox" checked={s.ignore} onChange={(e) => set({ ignore: e.target.checked })} /> Not tracked here (ignore)
              </label>
              {r.match.saved && !s.ignore && <span className="tiny muted">saved match</span>}
            </div>
          </div>
        );
      })}
      {filter === "all" && parsed.itemsWithoutUsage.length > 0 && (
        <div className="card warn">
          <h2>SKUs with no usage in this file ({parsed.itemsWithoutUsage.length})</h2>
          <div className="small">These keep using the master average or observed usage.</div>
          <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18, maxHeight: 220, overflow: "auto" }}>
            {parsed.itemsWithoutUsage.map((i) => (
              <li key={i.sku}>
                {i.name} <span className="muted">({i.sku})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="sticky-bar">
        <div className="inner">
          <div className="grow small">
            {dayCount} days · <strong>{parsed.rows.filter((r) => state[r.sourceName].sku && !state[r.sourceName].ignore).length}</strong> matched
          </div>
          <button className="btn" onClick={() => setParsed(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={commit}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
