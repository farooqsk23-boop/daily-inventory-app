import { useRef, useState } from "react";
import { api, type Settings } from "../api.ts";
import { useDash } from "../App.tsx";
import { Icon, TopBar, errMsg, useLoad, useToast } from "../ui.tsx";

export function SettingsPage() {
  const { dash, refresh } = useDash();
  const toast = useToast();
  const [s, setS] = useState<Settings>(dash!.settings);
  const [holiday, setHoliday] = useState("");
  const [saving, setSaving] = useState(false);
  const health = useLoad<{ ocr: boolean; ocrProvider: ProviderId; ocrProviders: ScanStatus["providers"]; pushSubscribers: number; auth: boolean }>("/health");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const next = await api.put<Settings>("/settings", s);
      setS(next);
      refresh();
      toast("Settings saved");
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setSaving(false);
    }
  };
  const num = (k: keyof Settings, label: string, hint?: string, step = "1") => (
    <label className="field">
      <span>{label}</span>
      <input className="input" type="number" step={step} min="0" value={String(s[k])} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
      {hint && <div className="tiny muted" style={{ marginTop: 4 }}>{hint}</div>}
    </label>
  );

  return (
    <>
      <TopBar title="Settings" />
      <AiScan
        status={health.data ? { provider: health.data.ocrProvider, providers: health.data.ocrProviders } : null}
        onChange={() => {
          health.reload();
          refresh();
        }}
      />
      <form onSubmit={save}>
        <div className="card">
          <h2>Ordering</h2>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {num("safetyMultiplier", "Safety stock multiplier", "× average daily usage", "0.1")}
            <label className="field">
              <span>Order cutoff</span>
              <input className="input" type="time" value={s.cutoff} onChange={(e) => setS({ ...s, cutoff: e.target.value })} />
            </label>
            {num("leadDays", "Supplier lead time", "working days (1 = next day)")}
            {num("forecastHorizonDays", "Average usage over", "days of forecast")}
          </div>
          <label className="check">
            <input type="checkbox" checked={s.sundayUsage} onChange={(e) => setS({ ...s, sundayUsage: e.target.checked })} />
            Packaging is used on Sundays too (when not in the forecast file)
          </label>
        </div>

        <div className="card">
          <h2>Alerts</h2>
          <label className="field">
            <span>Order reminders (Mon–Sat)</span>
            <div className="row">
              {s.reminderTimes.map((t, i) => (
                <div key={i} className="row nowrap" style={{ gap: 4 }}>
                  <input className="input" type="time" style={{ width: 130 }} value={t} onChange={(e) => setS({ ...s, reminderTimes: s.reminderTimes.map((x, j) => (j === i ? e.target.value : x)) })} />
                  <button type="button" className="btn sm ghost" onClick={() => setS({ ...s, reminderTimes: s.reminderTimes.filter((_, j) => j !== i) })} aria-label="Remove reminder">
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="btn sm" onClick={() => setS({ ...s, reminderTimes: [...s.reminderTimes, "11:00"] })}>
                <Icon name="plus" /> Add
              </button>
            </div>
          </label>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {num("depletionWarnDays", "Depletion warning", "days before the last safe order day")}
            {num("notOrderedDays", "Flag not ordered after", "days")}
            {num("discrepancyPct", "Discrepancy flag at", "% of expected stock")}
            {num("discrepancyMin", "…and at least", "units")}
          </div>
        </div>

        <div className="card">
          <h2>Warehouse calendar</h2>
          <p className="small muted" style={{ marginTop: 0 }}>Sunday is always closed. Add public holidays or other closed days here.</p>
          <div className="row" style={{ marginBottom: 10 }}>
            {s.holidays.map((h) => (
              <span key={h} className="pill info">
                {h}
                <button type="button" style={{ border: 0, background: "none", cursor: "pointer" }} onClick={() => setS({ ...s, holidays: s.holidays.filter((x) => x !== h) })}>
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="row nowrap">
            <input className="input" type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} />
            <button type="button" className="btn" disabled={!holiday} onClick={() => { setS({ ...s, holidays: [...new Set([...s.holidays, holiday])].sort() }); setHoliday(""); }}>
              Add
            </button>
          </div>
          <label className="field" style={{ marginTop: 12 }}>
            <span>Time zone</span>
            <input className="input" value={s.timeZone} onChange={(e) => setS({ ...s, timeZone: e.target.value })} />
          </label>
        </div>

        <div className="card">
          <h2>You</h2>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Name shown in the audit trail</span>
            <input className="input" value={s.controllerName} onChange={(e) => setS({ ...s, controllerName: e.target.value })} />
          </label>
        </div>
        <button className="btn primary block" disabled={saving} style={{ marginBottom: 14 }}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>

      <Notifications subscribers={health.data?.pushSubscribers ?? 0} onChange={health.reload} />
      <MasterImport />

      <div className="card small">
        <h2>Server</h2>
        <div>PIN lock: {health.data?.auth ? <span className="pill ok">on</span> : <span className="pill">off — set APP_PIN</span>}</div>
      </div>
    </>
  );
}

function urlB64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function Notifications({ subscribers, onChange }: { subscribers: number; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const enable = async () => {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notifications are blocked. Allow them in your browser settings.");
      const reg = await navigator.serviceWorker.ready;
      const { key } = await api.get<{ key: string }>("/push/key");
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) }));
      await api.post("/push/subscribe", sub.toJSON());
      toast("Notifications on for this device");
      onChange();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      const r = await api.post<{ sent: number }>("/push/test");
      toast(r.sent ? "Test sent" : "No devices subscribed yet");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <div className="card">
      <h2>
        Notifications <span className="small muted">{subscribers} device{subscribers === 1 ? "" : "s"}</span>
      </h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Order reminders before the cutoff (no reminders on Sundays or closed days) and low-stock alerts after each count. On iPhone, add the app to the Home Screen first (Share → Add to Home Screen).
      </p>
      {supported ? (
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={enable}>
            <Icon name="bell" /> Enable on this device
          </button>
          <button className="btn" onClick={test}>
            Send test
          </button>
        </div>
      ) : (
        <div className="small">This browser does not support push notifications.</div>
      )}
    </div>
  );
}

function MasterImport() {
  const toast = useToast();
  const { refresh } = useDash();
  const ref = useRef<HTMLInputElement>(null);
  const upload = async (file?: File) => {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api.post<{ added: number; updated: number }>("/items/import", fd);
      toast(`${r.added} added, ${r.updated} updated`);
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      if (ref.current) ref.current.value = "";
    }
  };
  return (
    <div className="card">
      <h2>Master inventory</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Upload the daily inventory workbook to add new SKUs and update names, suppliers, pack sizes, max holding and average usage. Your per-item minimum levels and units are kept.
      </p>
      <button className="btn" onClick={() => ref.current?.click()}>
        <Icon name="upload" /> Import from Excel
      </button>
      <input ref={ref} type="file" accept=".xlsx,.xlsm" hidden onChange={(e) => upload(e.target.files?.[0])} />
    </div>
  );
}

type ProviderId = "claude" | "gemini";
type KeySource = "env" | "settings" | null;
export interface ScanStatus {
  provider: ProviderId;
  providers: Record<ProviderId, { label: string; source: KeySource; model: string }>;
}

const PROVIDER_INFO: Record<ProviderId, { placeholder: string; where: string; env: string }> = {
  claude: { placeholder: "sk-ant-…", where: "console.anthropic.com → API keys", env: "ANTHROPIC_API_KEY" },
  gemini: { placeholder: "AIza…", where: "aistudio.google.com → Get API key", env: "GEMINI_API_KEY" },
};

function AiScan({ status, onChange }: { status: ScanStatus | null; onChange: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const provider = status?.provider ?? "claude";
  const info = PROVIDER_INFO[provider];
  const p = status?.providers[provider];
  const source = p?.source ?? null;

  const choose = async (next: ProviderId) => {
    if (next === provider) return;
    setSwitching(true);
    try {
      await api.put("/ocr/provider", { provider: next });
      setKey("");
      onChange();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setSwitching(false);
    }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put("/ocr/key", { provider, key });
      setKey("");
      toast(`AI scan is on with ${p?.label ?? provider}`);
      onChange();
    } catch (err) {
      toast(errMsg(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove the ${p?.label} API key? AI scan will stop working with ${p?.label} until you add one again.`)) return;
    await api.del("/ocr/key", { provider });
    onChange();
  };

  return (
    <div className={`card ${status && !source ? "warn" : ""}`}>
      <h2>
        <span className="row nowrap" style={{ gap: 8 }}>
          <Icon name="scan" /> AI scan
        </span>
        {status && (source ? <span className="pill ok">on · {p?.label}</span> : <span className="pill low">off</span>)}
      </h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Reads handwritten count sheets and delivery notes from your photos. You still check every number before anything is saved.
      </p>
      <div className="field">
        <span className="small" style={{ display: "block", color: "var(--ink-2)", fontWeight: 500, marginBottom: 6 }}>
          Provider
        </span>
        <div className="seg" role="radiogroup" aria-label="AI scan provider">
          {(["claude", "gemini"] as const).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={provider === id} className={provider === id ? "on" : ""} disabled={switching} onClick={() => choose(id)}>
              {status?.providers[id].label ?? id}
              {status?.providers[id].source ? " ✓" : ""}
            </button>
          ))}
        </div>
      </div>

      {provider === "gemini" && (
        <div className="card warn small" style={{ boxShadow: "none" }}>
          <strong>Privacy on Gemini's free tier.</strong> Google may use the photos you send on the free tier to improve its products, and people may review them. Check
          Google's Gemini API terms (ai.google.dev/gemini-api/terms) before sending sheets, especially anything confidential. Keys on a paid (billing-enabled) Google project are
          covered by different terms.
        </div>
      )}

      {source === "env" ? (
        <div className="small">
          Switched on by the server's {info.env} (model {p?.model}).
        </div>
      ) : (
        <form onSubmit={save}>
          <label className="field">
            <span>
              {source ? "Replace" : ""} {p?.label ?? provider} API key
            </span>
            <input className="input" type="password" autoComplete="off" placeholder={info.placeholder} value={key} onChange={(e) => setKey(e.target.value)} />
            <div className="tiny muted" style={{ marginTop: 4 }}>
              Create one at {info.where}. It is kept on the server only and never shown again.
            </div>
          </label>
          <div className="row">
            <button className="btn primary" disabled={busy || !key.trim()}>
              {busy ? "Checking key…" : source ? "Replace key" : `Switch on with ${p?.label ?? provider}`}
            </button>
            {source === "settings" && (
              <button type="button" className="btn danger" onClick={remove}>
                Remove key
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
