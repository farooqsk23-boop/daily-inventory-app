import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { useDash } from "../App.tsx";
import { Conf, ErrorBox, Icon, Loading, PhotoPicker, StatusPill, TopBar, errMsg, useToast } from "../ui.tsx";
import { day, fmt, unitLabel, type PreparedPhoto } from "../util.ts";
import type { Status } from "../../../shared/types.ts";

interface SheetRow {
  row: number;
  sku: string;
  name: string;
  unit: string;
  packSize: number | null;
}
interface OcrLine {
  sku: string;
  count: number | null;
  confidence: "high" | "medium" | "low";
  note: string;
}
interface OcrResponse {
  photos: string[];
  quality: { photo: string; readable: boolean; problem: string; rowsRead: number }[];
  lines: OcrLine[];
}
interface Context {
  context: Record<string, { prev: { date: string; qty: number } | null; expected: number | null }>;
  discrepancyPct: number;
  discrepancyMin: number;
}
interface SaveResult {
  saved: number;
  flagged: { sku: string; name: string; stock: number; status: Status; statusReason: string; orderQty: number; daysOfCover: number | null }[];
}

type Step = "start" | "reading" | "review" | "done";
type Filter = "check" | "all" | "missing" | "gaps";

export function Count() {
  const { dash, refresh } = useDash();
  const toast = useToast();
  const [step, setStep] = useState<Step>("start");
  const [date, setDate] = useState(dash!.today);
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [sheet, setSheet] = useState<SheetRow[] | null>(null);
  const [ctx, setCtx] = useState<Context | null>(null);
  const [ocr, setOcr] = useState<OcrResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>("check");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    api.get<{ rows: SheetRow[] }>("/count/sheet").then((r) => setSheet(r.rows)).catch((e) => setError(errMsg(e)));
  }, []);
  useEffect(() => {
    api.get<Context>(`/count/context?date=${date}`).then(setCtx).catch(() => setCtx(null));
  }, [date]);

  const ocrBySku = useMemo(() => new Map((ocr?.lines ?? []).map((l) => [l.sku, l])), [ocr]);

  const readPhotos = async () => {
    setStep("reading");
    setError(null);
    const fd = new FormData();
    photos.forEach((p, i) => fd.append("photos", p.blob, `count-${i + 1}.jpg`));
    try {
      const r = await api.post<OcrResponse>("/count/ocr", fd);
      setOcr(r);
      const v: Record<string, string> = {};
      for (const l of r.lines) if (l.count != null) v[l.sku] = String(l.count);
      setValues(v);
      setFilter("check");
      setStep("review");
    } catch (e) {
      setError(errMsg(e));
      setStep("start");
    }
  };

  const manual = () => {
    setOcr(null);
    setValues({});
    setFilter("all");
    setStep("review");
  };

  const gapOf = (sku: string) => {
    const v = values[sku];
    const c = ctx?.context[sku];
    if (v == null || v === "" || !c || c.expected == null) return null;
    const gap = Number(v) - c.expected;
    const pct = c.expected !== 0 ? (gap / Math.abs(c.expected)) * 100 : null;
    const flagged = Math.abs(gap) >= (ctx?.discrepancyMin ?? 2) && (pct == null || Math.abs(pct) >= (ctx?.discrepancyPct ?? 20));
    return { gap, pct, flagged, expected: c.expected };
  };

  const needsCheck = (sku: string) => {
    const o = ocrBySku.get(sku);
    const v = values[sku];
    if (v == null || v === "") return true;
    if (o && (o.confidence !== "high" || o.note)) return true;
    if (o && o.count != null && Number(v) !== o.count) return true;
    return !!gapOf(sku)?.flagged;
  };

  const matches = (f: Filter, sku: string) => {
    if (f === "check") return needsCheck(sku);
    if (f === "missing") return values[sku] == null || values[sku] === "";
    if (f === "gaps") return !!gapOf(sku)?.flagged;
    return true;
  };
  // The filtered set is fixed when a tab is chosen, so a row doesn't vanish
  // while you are typing into it.
  const [snapshot, setSnapshot] = useState<Set<string> | null>(null);
  const pick = (f: Filter) => {
    setFilter(f);
    setSnapshot(new Set((sheet ?? []).filter((r) => matches(f, r.sku)).map((r) => r.sku)));
  };
  useEffect(() => {
    if (step === "review" && sheet) setSnapshot(new Set(sheet.filter((r) => matches(filter, r.sku)).map((r) => r.sku)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, ocr, sheet, ctx]);
  const rows = (sheet ?? []).filter((r) => {
    if (query && !`${r.name} ${r.sku}`.toLowerCase().includes(query.toLowerCase())) return false;
    return filter === "all" || (snapshot ? snapshot.has(r.sku) : matches(filter, r.sku));
  });

  const filled = (sheet ?? []).filter((r) => values[r.sku] != null && values[r.sku] !== "");
  const missing = (sheet?.length ?? 0) - filled.length;
  const invalid = filled.filter((r) => !(Number(values[r.sku]) >= 0));

  const save = async () => {
    if (invalid.length) return toast(`Fix ${invalid.length} invalid number(s) first`, "error");
    if (!filled.length) return toast("Enter at least one count", "error");
    const msg = missing
      ? `Save ${filled.length} counts for ${day(date)}?\n\n${missing} item(s) have no count and will keep their previous stock.`
      : `Save ${filled.length} counts for ${day(date)}?`;
    if (!confirm(msg)) return;
    setSaving(true);
    try {
      const r = await api.post<SaveResult>("/count/commit", {
        date,
        photos: ocr?.photos ?? [],
        lines: filled.map((row) => ({ sku: row.sku, qty: Number(values[row.sku]), ocrQty: ocrBySku.get(row.sku)?.count ?? null })),
      });
      setResult(r);
      setStep("done");
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  if (step === "reading") return <Loading label={`Reading ${photos.length} photo${photos.length === 1 ? "" : "s"}… this takes about 20–40 seconds`} />;

  if (step === "done" && result) return <Done result={result} onAgain={() => { setStep("start"); setPhotos([]); setOcr(null); setValues({}); }} />;

  if (step === "start")
    return (
      <>
        <TopBar title="Daily count" sub="Count on the printed sheet, then photograph it" />
        {error && <ErrorBox error={error} />}
        <div className="card">
          <label className="field">
            <span>Count date</span>
            <input className="input" type="date" value={date} max={dash!.today} onChange={(e) => setDate(e.target.value)} />
          </label>
          <a className="btn block" href="#/print" target="_blank" rel="noreferrer">
            <Icon name="print" /> Print blank count sheet
          </a>
        </div>
        <div className="card">
          <h2>Photos of the count sheet</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            One photo per page, flat, in good light, with the whole page in frame.
          </p>
          <PhotoPicker photos={photos} onChange={setPhotos} label="Take photo" />
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary grow" disabled={!photos.length || !dash!.ocr} onClick={readPhotos}>
              <Icon name="check" /> Read counts
            </button>
            <button className="btn" onClick={manual}>
              Type in
            </button>
          </div>
          {!dash!.ocr && <div className="small muted" style={{ marginTop: 8 }}>Photo reading is not set up on the server (ANTHROPIC_API_KEY). You can type counts in.</div>}
        </div>
      </>
    );

  // ----- review -----
  const unreadable = ocr?.quality.filter((q) => !q.readable) ?? [];
  return (
    <div className="has-sticky">
      <TopBar title="Check the counts" sub={`${day(date)} · nothing is saved until you confirm`} />
      {unreadable.length > 0 && (
        <div className="card warn">
          <strong>
            {unreadable.length} photo{unreadable.length === 1 ? "" : "s"} could not be read — please retake
          </strong>
          <ul className="small" style={{ margin: "6px 0 10px", paddingLeft: 18 }}>
            {unreadable.map((q) => (
              <li key={q.photo}>{q.problem || "Unclear photo"}</li>
            ))}
          </ul>
          <button className="btn sm" onClick={() => { setPhotos(photos.filter((_, i) => ocr!.quality[i]?.readable)); setStep("start"); }}>
            <Icon name="camera" /> Retake
          </button>
        </div>
      )}
      {ocr && ocr.lines.length === 0 && unreadable.length === 0 && (
        <div className="card warn small">No handwritten counts were found. Check that the photo shows the filled-in sheet, or type the counts in.</div>
      )}
      <div className="tabs">
        {(
          [
            ["check", `To check (${(sheet ?? []).filter((r) => needsCheck(r.sku)).length})`],
            ["missing", `Missing (${missing})`],
            ["gaps", `Gaps (${(sheet ?? []).filter((r) => gapOf(r.sku)?.flagged).length})`],
            ["all", `All (${sheet?.length ?? 0})`],
          ] as [Filter, string][]
        ).map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => pick(k)}>
            {l}
          </button>
        ))}
      </div>
      <input className="input" placeholder="Search item or SKU" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 12 }} />
      {!sheet ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card empty">{filter === "check" ? "Everything looks good. Review “All” or save." : "Nothing here."}</div>
      ) : (
        <div className="list">
          {rows.map((r) => {
            const o = ocrBySku.get(r.sku);
            const v = values[r.sku] ?? "";
            const g = gapOf(r.sku);
            const prev = ctx?.context[r.sku]?.prev;
            const changed = o?.count != null && v !== "" && Number(v) !== o.count;
            return (
              <div key={r.sku} className={`li ${g?.flagged ? "flag-amber" : ""}`}>
                <div className="grow">
                  <div className="name">
                    <span className="muted">#{r.row} </span>
                    {r.name}
                  </div>
                  <div className="meta">
                    {r.sku} · {unitLabel(r.unit)}
                    {prev ? ` · last ${fmt(prev.qty)} on ${day(prev.date, false)}` : ""}
                  </div>
                  <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                    {o ? (
                      <>
                        <Conf level={o.count == null ? "none" : o.confidence} />
                        <span className="muted">read: {o.count ?? "blank"}</span>
                      </>
                    ) : ocr ? (
                      <span className="chip-conf none">not on photo</span>
                    ) : null}
                    {g && (
                      <span className={g.flagged ? "pill low" : "muted"}>
                        expected {fmt(g.expected, 1)} · gap {g.gap > 0 ? "+" : ""}
                        {fmt(g.gap, 1)}
                      </span>
                    )}
                  </div>
                  {o?.note && <div className="small" style={{ color: "#92400e", marginTop: 3 }}>{o.note}</div>}
                </div>
                <input
                  className={`num-input ${changed ? "changed" : ""} ${v === "" ? "missing" : ""}`}
                  inputMode="decimal"
                  aria-label={`Count for ${r.name}`}
                  value={v}
                  placeholder="—"
                  onChange={(e) => setValues({ ...values, [r.sku]: e.target.value.replace(/[^\d.]/g, "") })}
                />
              </div>
            );
          })}
        </div>
      )}
      <div className="sticky-bar">
        <div className="inner">
          <div className="grow small">
            <strong>{filled.length}</strong> counted · <span className="muted">{missing} missing</span>
          </div>
          <button className="btn" onClick={() => setStep("start")}>
            Back
          </button>
          <button className="btn primary" disabled={saving || !filled.length} onClick={save}>
            {saving ? "Saving…" : "Confirm & save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Done({ result, onAgain }: { result: SaveResult; onAgain: () => void }) {
  const crit = result.flagged.filter((f) => f.status === "critical");
  const low = result.flagged.filter((f) => f.status === "low");
  return (
    <>
      <TopBar title="Count saved" sub={`${result.saved} items updated`} />
      <div className="grid kpi" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 14 }}>
        <div className="kpi-tile red">
          <div className="n">{crit.length}</div>
          <div className="l">Critical</div>
        </div>
        <div className="kpi-tile amber">
          <div className="n">{low.length}</div>
          <div className="l">Low</div>
        </div>
        <div className="kpi-tile green">
          <div className="n">{result.saved - result.flagged.length}</div>
          <div className="l">OK</div>
        </div>
      </div>
      {result.flagged.length > 0 ? (
        <div className="card">
          <h2>Low stock after this count</h2>
          <div className="list">
            {[...crit, ...low].map((f) => (
              <a key={f.sku} className={`li ${f.status === "critical" ? "flag-red" : "flag-amber"}`} href={`#/items/${encodeURIComponent(f.sku)}`}>
                <span className={`dot ${f.status}`} />
                <div className="grow">
                  <div className="name">{f.name}</div>
                  <div className="meta">
                    {f.statusReason} · {fmt(f.daysOfCover, 1)} days of cover
                  </div>
                </div>
                <div className="qty">{fmt(f.stock)}</div>
                <StatusPill status={f.status} />
              </a>
            ))}
          </div>
        </div>
      ) : (
        <div className="card tint">All counted items are above their safety stock and minimum levels.</div>
      )}
      <div className="row">
        <a className="btn primary grow" href="#/order">
          <Icon name="cart" /> Go to order list
        </a>
        <button className="btn" onClick={onAgain}>
          New count
        </button>
      </div>
    </>
  );
}
