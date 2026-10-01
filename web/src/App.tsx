import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { api, type Dashboard } from "./api.ts";
import { Icon, useLoad, useRoute, Loading, ErrorBox } from "./ui.tsx";
import { Home } from "./pages/Home.tsx";
import { Count } from "./pages/Count.tsx";
import { Delivery } from "./pages/Delivery.tsx";
import { Usage } from "./pages/Usage.tsx";
import { Order } from "./pages/Order.tsx";
import { Items, ItemDetail } from "./pages/Items.tsx";
import { Mappings } from "./pages/Mappings.tsx";
import { Reports } from "./pages/Reports.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { Audit } from "./pages/Audit.tsx";
import { PrintSheet } from "./pages/PrintSheet.tsx";

interface Ctx {
  dash: Dashboard | null;
  refresh: () => void;
}
const DashCtx = createContext<Ctx>({ dash: null, refresh: () => {} });
export const useDash = () => useContext(DashCtx);

export function App() {
  const route = useRoute();
  const [needLogin, setNeedLogin] = useState(false);
  const { data: dash, error, reload } = useLoad<Dashboard>(needLogin ? null : "/dashboard", [needLogin]);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const on = () => setNeedLogin(true);
    addEventListener("stockroom:login", on);
    return () => removeEventListener("stockroom:login", on);
  }, []);

  // Refresh numbers when the app comes back to the foreground.
  useEffect(() => {
    const on = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [reload]);

  if (needLogin) return <Login onDone={() => setNeedLogin(false)} />;

  const page = route[0] ?? "";
  if (page === "print") return <PrintSheet />;

  let body;
  if (!dash && error) body = <ErrorBox error={error} retry={reload} />;
  else if (!dash) body = <Loading />;
  else
    body = (
      {
        "": <Home />,
        count: <Count />,
        delivery: <Delivery />,
        usage: <Usage />,
        order: <Order />,
        items: route[1] ? <ItemDetail sku={route[1]} /> : <Items />,
        mapping: <Mappings />,
        reports: <Reports />,
        settings: <SettingsPage />,
        audit: <Audit />,
      } as Record<string, React.ReactElement>
    )[page] ?? <Home />;

  const toOrder = dash?.summary.toOrder ?? 0;
  const tab = (path: string, icon: string, label: string, badge?: number) => (
    <a href={`#/${path}`} className={page === path ? "on" : ""}>
      <Icon name={icon} />
      {label}
      {!!badge && <span className="badge">{badge}</span>}
    </a>
  );
  const morePages = ["items", "mapping", "reports", "settings", "audit"];

  return (
    <DashCtx.Provider value={{ dash, refresh: reload }}>
      <div className="app">{body}</div>
      <nav className="nav no-print">
        {tab("", "home", "Home")}
        {tab("count", "count", "Count")}
        {tab("delivery", "truck", "Delivery")}
        {tab("usage", "chart", "Usage")}
        {tab("order", "cart", "Order", toOrder)}
        <button className={morePages.includes(page) ? "on" : ""} onClick={() => setMore(true)}>
          <Icon name="more" />
          More
          {!!dash?.unmatchedMappings && <span className="badge">{dash.unmatchedMappings}</span>}
        </button>
      </nav>
      {more && (
        <>
          <div className="sheet-backdrop" onClick={() => setMore(false)} />
          <div className="sheet" onClick={() => setMore(false)}>
            <div className="list">
              <a className="li" href="#/items">
                <Icon name="box" /> <span className="grow">Items &amp; history</span>
              </a>
              <a className="li" href="#/reports">
                <Icon name="list" /> <span className="grow">Reports &amp; exports</span>
              </a>
              <a className="li" href="#/mapping">
                <Icon name="link" /> <span className="grow">SKU matching</span>
                {!!dash?.unmatchedMappings && <span className="pill critical">{dash.unmatchedMappings} unmatched</span>}
              </a>
              <a className="li" href="#/audit">
                <Icon name="history" /> <span className="grow">Audit trail</span>
              </a>
              <a className="li" href="#/settings">
                <Icon name="settings" /> <span className="grow">Settings</span>
              </a>
            </div>
          </div>
        </>
      )}
    </DashCtx.Provider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/login", { pin });
      onDone();
    } catch {
      setErr("Wrong PIN");
    }
  };
  return (
    <div className="app">
      <form className="card" style={{ maxWidth: 360, margin: "15vh auto" }} onSubmit={submit}>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="brand-dot">
            <Icon name="box" size={18} />
          </div>
          <strong>Stockroom</strong>
        </div>
        <label className="field">
          <span>PIN</span>
          <input className="input" type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} />
        </label>
        {err && <div className="small" style={{ color: "var(--red)", marginBottom: 10 }}>{err}</div>}
        <button className="btn primary block">Unlock</button>
      </form>
    </div>
  );
}
