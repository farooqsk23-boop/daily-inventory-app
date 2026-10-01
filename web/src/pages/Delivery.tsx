import { useState } from "react";
import { api, type Item, type MatchResult, type OpenLine } from "../api.ts";
import { useDash } from "../App.tsx";
import { Conf, Icon, Loading, PhotoPicker, SkuSelect, TopBar, errMsg, useLoad, useToast } from "../ui.tsx";
import { day, fmt, unitLabel, type PreparedPhoto } from "../util.ts";

interface OcrLine {
  code: string;
  description: string;
  quantity: number | null;
  unit: string;
  confidence: "high" | "medium" | "low";
  note: string;
  match: MatchResult & { saved: boolean };
}
interface OcrResponse {
  photos: string[];
  supplier: string;
  reference: string;
  date: string;
  lines: OcrLine[];
}

interface Line {
  key: string;
  sourceName: string;
  sku: string | null;
  qty: string;
  ocrQty: number | null;
  rawNote: string;
  match: (MatchResult & { saved?: boolean }) | null;
  confirmed: boolean; // mapping checked by the controller
  keepOpen: boolean;
  confidence?: string;
}

interface Check {
  sku: string;
  delivered: number;
  ordered: number;
  shortage: number;
}

const PIECES = /^(pc|pcs|piece|pieces|nos|no|ea|each|units?)$/i;

export function Delivery() {
  const { dash, refresh } = useDash();
  const toast = useToast();
  const items = useLoad<Item[]>("/items");
  const open = useLoad<OpenLine[]>("/delivery/open");
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [step, setStep] = useState<"start" | "reading" | "review" | "done">("start");
  const [date, setDate] = useState(dash!.today);
  const [supplier, setSupplier] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [retake, setRetake] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);

  const itemMap = new Map((items.data ?? []).map((i) => [i.sku, i]));
  const outstanding = (sku: string | null) =>
    sku ? (open.data ?? []).filter((o) => o.sku === sku && o.expected_delivery <= date).reduce((a, o) => a + o.outstanding, 0) : 0;

  const read = async () => {
    setStep("reading");
    setRetake(null);
    const fd = new FormData();
    photos.forEach((p, i) => fd.append("photos", p.blob, `delivery-${i + 1}.jpg`));
    try {
      const r = await api.post<OcrResponse>("/delivery/ocr", fd);
      setPhotoIds(r.photos);
      if (r.supplier) setSupplier(r.supplier);
      if (r.reference) setReference(r.reference);
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date <= dash!.today) setDate(r.date);
      setLines(
        r.lines.map((l, i) => {
          const sku = l.match.sku;
          const item = sku ? itemMap.get(sku) : undefined;
          let qty = l.quantity;
          let rawNote = l.note;
          if (qty != null && item && item.unit === "carton" && item.packSize && PIECES.test(l.unit.trim())) {
            rawNote = `${fmt(qty)} ${l.unit} ÷ ${item.packSize}/ctn${rawNote ? ` · ${rawNote}` : ""}`;
            qty = Math.round((qty / item.packSize) * 100) / 100;
          }
          return {
            key: `o${i}`,
            sourceName: [l.code, l.description].filter(Boolean).join(" "),
            sku,
            qty: qty == null ? "" : String(qty),
            ocrQty: qty,
            rawNote: [l.unit && !rawNote.includes("÷") ? `unit: ${l.unit}` : "", rawNote].filter(Boolean).join(" · "),
            match: l.match,
            confirmed: l.match.saved || l.match.level === "exact",
            keepOpen: false,
            confidence: l.confidence,
          };
        }),
      );
      setStep("review");
    } catch (e) {
      const msg = errMsg(e);
      setStep("start");
      setRetake(msg);
    }
  };

  const addFromOrder = (o: OpenLine) => {
    setLines([...lines, { key: `m${Date.now()}`, sourceName: "", sku: o.sku, qty: String(o.outstanding), ocrQty: null, rawNote: `Order #${o.order_id}`, match: null, confirmed: true, keepOpen: false }]);
    setStep("review");
  };
  const addBlank = () => {
    setLines([...lines, { key: `m${Date.now()}`, sourceName: "", sku: null, qty: "", ocrQty: null, rawNote: "", match: null, confirmed: true, keepOpen: false }]);
    setStep("review");
  };
  const update = (key: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const unmatched = lines.filter((l) => !l.sku && l.qty !== "");
  const unconfirmed = lines.filter((l) => l.sku && !l.confirmed);
  const ready = lines.filter((l) => l.sku && Number(l.qty) > 0);

  const save = async () => {
    if (unconfirmed.length) return toast("Confirm the highlighted item matches first", "error");
    if (!ready.length) return toast("Nothing to save", "error");
    if (unmatched.length && !confirm(`${unmatched.length} line(s) are not matched to a SKU and will be skipped. Continue?`)) return;
    setSaving(true);
    try {
      const r = await api.post<{ checks: Check[] }>("/delivery/commit", {
        date,
        supplier,
        reference,
        photos: photoIds,
        lines: ready.map((l) => ({
          sku: l.sku,
          qty: Number(l.qty),
          ocrQty: l.ocrQty,
          sourceName: l.sourceName || undefined,
          confirmed: !!l.match && !l.match.saved && l.confirmed,
          keepOpen: l.keepOpen,
        })),
      });
      setChecks(r.checks);
      setStep("done");
      refresh();
      open.reload();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  if (step === "reading") return <Loading label="Reading the delivery note…" />;

  if (step === "done" && checks)
    return (
      <>
        <TopBar title="Delivery saved" sub={`${checks.length} items added to stock`} />
        <div className="card">
          <h2>Delivery check</h2>
          <div className="list">
            {checks.map((c) => {
              const it = itemMap.get(c.sku);
              return (
                <div key={c.sku} className={`li ${c.shortage ? "flag-red" : c.ordered === 0 ? "flag-amber" : ""}`}>
                  <div className="grow">
                    <div className="name">{it?.name ?? c.sku}</div>
                    <div className="meta">
                      {c.ordered ? `Ordered ${fmt(c.ordered)} · delivered ${fmt(c.delivered)}` : `Delivered ${fmt(c.delivered)} · no open order`}
                    </div>
                  </div>
                  {c.shortage ? <span className="pill critical">short {fmt(c.shortage)}</span> : c.ordered ? <span className="pill ok">complete</span> : <span className="pill low">unordered</span>}
                </div>
              );
            })}
          </div>
        </div>
        <button className="btn primary block" onClick={() => { setStep("start"); setLines([]); setPhotos([]); setChecks(null); setSupplier(""); setReference(""); }}>
          Record another delivery
        </button>
      </>
    );

  if (step === "start")
    return (
      <>
        <TopBar title="Delivery" sub="Photograph the delivery note" />
        {retake && (
          <div className="card warn">
            <strong>Please retake the photo</strong>
            <div className="small">{retake}</div>
          </div>
        )}
        <div className="card">
          <PhotoPicker photos={photos} onChange={setPhotos} label="Delivery note" />
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary grow" disabled={!photos.length || !dash!.ocr} onClick={read}>
              <Icon name="check" /> Read delivery note
            </button>
            <button className="btn" onClick={addBlank}>
              Type in
            </button>
          </div>
          {!dash!.ocr && <div className="small muted" style={{ marginTop: 8 }}>Photo reading is not set up on the server. Type the lines in or receive against an order below.</div>}
        </div>
        <OpenOrders open={open.data} onPick={addFromOrder} today={dash!.today} />
      </>
    );

  // review
  return (
    <div className="has-sticky">
      <TopBar title="Check the delivery" sub="Nothing is added to stock until you confirm" />
      <div className="card">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="field">
            <span>Date received</span>
            <input className="input" type="date" value={date} max={dash!.today} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Note / DO number</span>
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
        </div>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Supplier</span>
          <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </label>
      </div>

      {lines.map((l) => {
        const it = l.sku ? itemMap.get(l.sku) : undefined;
        const out = outstanding(l.sku);
        const q = Number(l.qty);
        const short = out > 0 && l.qty !== "" && q < out;
        const needConfirm = l.sku && !l.confirmed;
        return (
          <div key={l.key} className={`card ${needConfirm ? "warn" : !l.sku ? "danger" : ""}`}>
            {l.sourceName && (
              <div className="small" style={{ marginBottom: 8 }}>
                <span className="muted">On note: </span>
                <strong>{l.sourceName}</strong> {l.confidence && <Conf level={l.confidence} />}
              </div>
            )}
            <div className="row nowrap" style={{ alignItems: "flex-start" }}>
              <div className="grow">
                <SkuSelect value={l.sku} items={items.data ?? []} suggestions={l.match?.suggestions ?? []} onChange={(sku) => update(l.key, { sku, confirmed: true })} />
                {l.match && l.sku && (
                  <div className="row small" style={{ marginTop: 6, gap: 6 }}>
                    <Conf level={l.match.saved ? "exact" : l.match.level} />
                    <span className="muted">{l.match.saved ? "saved match" : `${Math.round(l.match.confidence * 100)}% match`}</span>
                    {needConfirm && (
                      <button className="btn sm primary" onClick={() => update(l.key, { confirmed: true })}>
                        Yes, correct
                      </button>
                    )}
                  </div>
                )}
                {!l.sku && <div className="small" style={{ color: "var(--red)", marginTop: 6 }}>Not matched — pick the SKU or it will be skipped</div>}
              </div>
              <div style={{ textAlign: "center" }}>
                <input className={`num-input ${l.ocrQty != null && l.qty !== "" && q !== l.ocrQty ? "changed" : ""}`} inputMode="decimal" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value.replace(/[^\d.]/g, "") })} />
                <div className="tiny muted">{it ? unitLabel(it.unit) : ""}</div>
              </div>
            </div>
            {l.rawNote && <div className="small muted" style={{ marginTop: 6 }}>{l.rawNote}</div>}
            {out > 0 && (
              <div className="row small" style={{ marginTop: 8, gap: 8 }}>
                <span className={short ? "pill critical" : "pill ok"}>
                  ordered {fmt(out)} {short ? `· short ${fmt(out - q)}` : "· ok"}
                </span>
                {short && (
                  <label className="check" style={{ minHeight: 0 }}>
                    <input type="checkbox" checked={l.keepOpen} onChange={(e) => update(l.key, { keepOpen: e.target.checked })} /> rest still coming
                  </label>
                )}
              </div>
            )}
            {l.sku && out === 0 && <div className="small" style={{ marginTop: 8 }}><span className="pill low">no open order for this item</span></div>}
            <button className="btn ghost sm" style={{ marginTop: 6, paddingLeft: 0 }} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>
              <Icon name="trash" /> Remove line
            </button>
          </div>
        );
      })}
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={addBlank}>
          <Icon name="plus" /> Add line
        </button>
      </div>
      <OpenOrders open={(open.data ?? []).filter((o) => !lines.some((l) => l.sku === o.sku))} onPick={addFromOrder} today={dash!.today} />
      <div className="sticky-bar">
        <div className="inner">
          <div className="grow small">
            <strong>{ready.length}</strong> lines
            {unconfirmed.length > 0 && <span style={{ color: "#92400e" }}> · {unconfirmed.length} to confirm</span>}
          </div>
          <button className="btn" onClick={() => setStep("start")}>
            Back
          </button>
          <button className="btn primary" disabled={saving || !ready.length} onClick={save}>
            {saving ? "Saving…" : "Confirm & add to stock"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OpenOrders({ open, onPick, today }: { open: OpenLine[] | null; onPick: (o: OpenLine) => void; today: string }) {
  if (!open?.length) return null;
  return (
    <div className="card">
      <h2>Awaiting delivery</h2>
      <div className="list">
        {open.map((o) => (
          <button key={o.id} className={`li ${o.expected_delivery < today ? "flag-amber" : ""}`} style={{ width: "100%", border: 0, background: "none", textAlign: "left", cursor: "pointer" }} onClick={() => onPick(o)}>
            <div className="grow">
              <div className="name">{o.name}</div>
              <div className="meta">
                Order #{o.order_id} · due {day(o.expected_delivery)}
                {o.expected_delivery < today ? " · overdue" : ""}
              </div>
            </div>
            <div className="qty">{fmt(o.outstanding)}</div>
            <Icon name="plus" />
          </button>
        ))}
      </div>
    </div>
  );
}
