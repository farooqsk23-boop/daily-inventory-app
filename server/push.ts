// Web Push notifications and the daily order reminder scheduler.
import webpush from "web-push";
import { isWorkingDay, localNow, toMinutes } from "../shared/calendar.ts";
import { all, get, getSecret, getSettings, nowIso, run, setSecret } from "./db.ts";
import { currentPlan } from "./state.ts";

export function vapidPublicKey(): string {
  let pub = getSecret("vapidPublic");
  let priv = getSecret("vapidPrivate");
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    setSecret("vapidPublic", pub);
    setSecret("vapidPrivate", priv);
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:stockroom@example.com", pub, priv);
  return pub;
}

export function saveSubscription(sub: webpush.PushSubscription) {
  run("INSERT OR REPLACE INTO push_subs (endpoint, json, created_at) VALUES (?, ?, ?)", sub.endpoint, JSON.stringify(sub), nowIso());
}

export function removeSubscription(endpoint: string) {
  run("DELETE FROM push_subs WHERE endpoint = ?", endpoint);
}

export function subscriptionCount(): number {
  return get<{ n: number }>("SELECT COUNT(*) n FROM push_subs")?.n ?? 0;
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function notifyAll(msg: PushMessage): Promise<number> {
  vapidPublicKey();
  let sent = 0;
  for (const r of all<{ endpoint: string; json: string }>("SELECT endpoint, json FROM push_subs")) {
    try {
      await webpush.sendNotification(JSON.parse(r.json), JSON.stringify(msg));
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) removeSubscription(r.endpoint);
      else console.warn("push failed", code ?? e);
    }
  }
  return sent;
}

export function orderReminderMessage(): PushMessage | null {
  const { plans, summary, settings } = currentPlan();
  const toOrder = plans.filter((p) => p.orderQty > 0).sort((a, b) => b.orderQty - a.orderQty);
  const urgent = plans.filter((p) => p.depletion?.severity === "too-late" || p.depletion?.severity === "order-now");
  if (!toOrder.length && !urgent.length && !summary.critical) return null;
  const top = toOrder
    .slice(0, 4)
    .map((p) => `${p.name.slice(0, 28)} × ${p.orderQty}`)
    .join(", ");
  const extra = toOrder.length > 4 ? ` +${toOrder.length - 4} more` : "";
  const parts = [`${toOrder.length} item${toOrder.length === 1 ? "" : "s"} to order before ${settings.cutoff}`];
  if (summary.critical) parts.push(`${summary.critical} critical`);
  if (urgent.length) parts.push(`${urgent.length} will run out soon`);
  return {
    title: `Order reminder — cutoff ${settings.cutoff}`,
    body: `${parts.join(" · ")}${top ? `\n${top}${extra}` : ""}`,
    url: "/#/order",
    tag: "order-reminder",
  };
}

/** Checks every 20s whether a reminder time has been reached (Mon–Sat, working days only). */
export function startScheduler() {
  const tick = async () => {
    try {
      const s = getSettings();
      const now = localNow(s.timeZone);
      if (!isWorkingDay(now.date, s)) return;
      for (const t of s.reminderTimes) {
        const m = toMinutes(t);
        // Fire within a 10-minute window so a restart doesn't skip the reminder,
        // but never after the cutoff.
        if (now.minutes < m || now.minutes >= m + 10 || now.minutes >= toMinutes(s.cutoff)) continue;
        const key = `${now.date}|${t}`;
        if (get("SELECT key FROM reminders_sent WHERE key = ?", key)) continue;
        run("INSERT INTO reminders_sent (key) VALUES (?)", key);
        const msg = orderReminderMessage();
        if (msg) await notifyAll(msg);
      }
    } catch (e) {
      console.error("scheduler", e);
    }
  };
  setInterval(tick, 20_000);
  void tick();
}
