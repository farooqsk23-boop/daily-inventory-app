import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

// Load .env from the project root if present (works the same on Windows, macOS and Linux).
const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { seedIfEmpty } = await import("./db.ts");
const { startScheduler, vapidPublicKey } = await import("./push.ts");
const { api } = await import("./routes.ts");

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const PIN = process.env.APP_PIN ?? "";

seedIfEmpty();
vapidPublicKey();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

// Optional single-user PIN. Set APP_PIN when the app is reachable from the internet.
const token = (pin: string) => createHash("sha256").update(`stockroom:${pin}`).digest("hex");
const cookieToken = (cookie: string | undefined) => /(?:^|;\s*)sr_auth=([a-f0-9]+)/.exec(cookie ?? "")?.[1] ?? "";

app.post("/api/login", (req, res) => {
  const pin = String(req.body?.pin ?? "");
  const a = Buffer.from(token(pin));
  const b = Buffer.from(token(PIN));
  if (!PIN || (a.length === b.length && timingSafeEqual(a, b))) {
    res.setHeader("Set-Cookie", `sr_auth=${token(PIN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Wrong PIN" });
});

app.use("/api", (req, res, next) => {
  if (!PIN || req.path === "/health") return next();
  if (cookieToken(req.headers.cookie) === token(PIN)) return next();
  res.status(401).json({ error: "Login required", login: true });
});

app.use("/api", api);

const dist = join(here, "..", "dist");
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h", setHeaders: (res, p) => p.endsWith("sw.js") && res.setHeader("Cache-Control", "no-cache") }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Stockroom running on http://localhost:${PORT}`);
  startScheduler();
});
