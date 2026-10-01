import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { localNow, toMinutes, type ISODate } from "../../shared/calendar.ts";
import type { Status } from "../../shared/types.ts";
import { api, ApiError } from "./api.ts";
import { preparePhoto, type PreparedPhoto } from "./util.ts";

// ---------- icons ----------

const PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  count: "M9 3h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2V4a1 1 0 0 1 1-1zM9 12l2 2 4-4M8 17h8",
  truck: "M3 6h11v10H3zM14 9h4l3 3v4h-7M7.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  cart: "M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2M9 20.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17 20.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  camera: "M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  print: "M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  copy: "M8 8h12v12H8zM4 16V4h12",
  share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v12M8 7l4-4 4 4",
  excel: "M5 3h10l4 4v14H5zM9 10l6 7M15 10l-6 7",
  pdf: "M5 3h10l4 4v14H5zM8 13h8M8 17h5M8 9h3",
  check: "M5 12l5 5 9-10",
  alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  box: "M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4.3V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  plus: "M12 5v14M5 12h14",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M12 7.5l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3-3.3-1.2 3.3-1.2z",
  key: "M15.5 7.5a3.5 3.5 0 1 1-3.4 4.3L4 20v-3h2v-2h2l1.6-1.6A3.5 3.5 0 0 1 15.5 7.5zM16 9h.01",
  back: "M15 18l-6-6 6-6",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
};

export function Icon({ name, size }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={size ?? 22} height={size ?? 22} style={{ flex: "none" }} aria-hidden>
      <path d={PATHS[name] ?? PATHS.box} />
    </svg>
  );
}

// ---------- routing ----------

export function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
}

export function routeQuery(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

export const go = (path: string) => {
  location.hash = path;
};

// ---------- data loading ----------

export function useLoad<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    if (!url) return;
    setLoading(true);
    api
      .get<T>(url)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="center">
      <div className="spinner" />
      <div className="muted small">{label}</div>
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="card danger">
      <div className="row between">
        <div>
          <strong>Something went wrong</strong>
          <div className="small">{error}</div>
        </div>
        {retry && (
          <button className="btn sm" onClick={retry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- toast ----------

const ToastCtx = createContext<(msg: string, kind?: "ok" | "error") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: string } | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((msg: string, kind: "ok" | "error" = "ok") => {
    setT({ msg, kind });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), kind === "error" ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast ${t.kind}`} role="status" onClick={() => setT(null)}>
          {t.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

// ---------- status ----------

export const STATUS_TEXT: Record<Status, string> = { ok: "OK", low: "Low", critical: "Critical", setup: "Setup" };

export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`pill ${status}`}>
      <span className={`dot ${status}`} style={{ width: 8, height: 8 }} />
      {STATUS_TEXT[status]}
    </span>
  );
}

export function Conf({ level }: { level: string }) {
  const label = { high: "sure", medium: "check", low: "unsure", none: "no match", exact: "exact", confirm: "confirm" }[level] ?? level;
  const cls = level === "exact" ? "high" : level === "confirm" ? "medium" : level;
  return <span className={`chip-conf ${cls}`}>{label}</span>;
}

// ---------- cutoff countdown ----------

export function useCutoff(timeZone: string, cutoff: string, isWorkingDay: (d: ISODate) => boolean) {
  const [now, setNow] = useState(() => localNow(timeZone));
  useEffect(() => {
    const t = setInterval(() => setNow(localNow(timeZone)), 1000);
    return () => clearInterval(t);
  }, [timeZone]);
  const working = isWorkingDay(now.date);
  const secsLeft = (toMinutes(cutoff) - now.minutes) * 60 - now.seconds;
  return { now, working, secsLeft, open: working && secsLeft > 0 };
}

export function Countdown({ secs }: { secs: number }) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return (
    <div className="countdown">
      {h > 0 && (
        <>
          <span className="big-num">{h}</span>
          <span className="unit">h</span>
        </>
      )}
      <span className="big-num">{String(m).padStart(h > 0 ? 2 : 1, "0")}</span>
      <span className="unit">m</span>
      <span className="big-num">{String(s).padStart(2, "0")}</span>
      <span className="unit">s</span>
    </div>
  );
}

// ---------- photo picker ----------

export function PhotoPicker({ photos, onChange, label = "Add photo" }: { photos: PreparedPhoto[]; onChange: (p: PreparedPhoto[]) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const out: PreparedPhoto[] = [];
    for (const f of Array.from(files)) {
      try {
        out.push(await preparePhoto(f));
      } catch (e) {
        toast(errMsg(e), "error");
      }
    }
    setBusy(false);
    onChange([...photos, ...out]);
    if (input.current) input.current.value = "";
  };
  return (
    <>
      <div className="photos">
        {photos.map((p) => (
          <div key={p.id} className={`photo ${p.problems.length ? "bad" : ""}`}>
            <img src={p.url} alt="" />
            <button className="x" aria-label="Remove photo" onClick={() => onChange(photos.filter((x) => x.id !== p.id))}>
              ×
            </button>
            {p.problems.length > 0 && <div className="q">Retake?</div>}
          </div>
        ))}
        <button className="add-photo" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? <div className="spinner" /> : <Icon name="camera" />}
          {label}
        </button>
      </div>
      <input ref={input} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => add(e.target.files)} />
      {photos.some((p) => p.problems.length) && (
        <div className="card warn small" style={{ marginTop: 12 }}>
          <strong>Some photos may be hard to read</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {[...new Set(photos.flatMap((p) => p.problems))].map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div style={{ marginTop: 6 }}>Retake them for the best result, or continue — you will check every number before saving.</div>
        </div>
      )}
    </>
  );
}

// ---------- SKU picker ----------

export function SkuSelect({
  value,
  onChange,
  items,
  suggestions = [],
  allowNone = true,
}: {
  value: string | null;
  onChange: (sku: string | null) => void;
  items: { sku: string; name: string }[];
  suggestions?: { sku: string; name: string; score: number }[];
  allowNone?: boolean;
}) {
  const sugg = new Set(suggestions.map((s) => s.sku));
  const rest = useMemo(() => [...items].sort((a, b) => a.name.localeCompare(b.name)), [items]);
  return (
    <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">— Not matched —</option>}
      {suggestions.length > 0 && (
        <optgroup label="Best matches">
          {suggestions.map((s) => (
            <option key={`s-${s.sku}`} value={s.sku}>
              {Math.round(s.score * 100)}% · {s.name} ({s.sku})
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="All items">
        {rest
          .filter((i) => !sugg.has(i.sku))
          .map((i) => (
            <option key={i.sku} value={i.sku}>
              {i.name} ({i.sku})
            </option>
          ))}
      </optgroup>
    </select>
  );
}

export function Back({ to, label = "Back" }: { to: string; label?: string }) {
  return (
    <a className="btn ghost sm no-print" href={to} style={{ paddingLeft: 0 }}>
      <Icon name="back" /> {label}
    </a>
  );
}

export function TopBar({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="topbar">
      <div className="grow">
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

/** Shown in place of AI scan results when no API key is configured yet. */
export function AiScanSetup() {
  return (
    <div className="card warn">
      <div className="row nowrap" style={{ alignItems: "flex-start" }}>
        <Icon name="key" />
        <div className="grow">
          <strong>Switch on AI scan</strong>
          <div className="small" style={{ margin: "4px 0 10px" }}>
            AI scan reads your handwritten counts and delivery notes. It needs a Claude API key, which you add once in Settings.
          </div>
          <a className="btn primary sm" href="#/settings">
            Set up AI scan
          </a>
        </div>
      </div>
    </div>
  );
}
