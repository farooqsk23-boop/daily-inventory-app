// Provider choice, key storage and routing. Uses a throwaway database.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockServer } from "./mock-server.ts";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_BASE_URL", "OCR_PROVIDER", "GEMINI_MODEL"];
const saved: Record<string, string | undefined> = {};

let ocr: typeof import("./index.ts");
let db: typeof import("../db.ts");

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "stockroom-ocr-"));
  process.env.DATA_DIR = dir;
  process.env.DB_PATH = join(dir, "test.db");
  db = await import("../db.ts");
  ocr = await import("./index.ts");
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  db.run("DELETE FROM settings");
});

afterAll(() => {
  for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
});

let server: Awaited<ReturnType<typeof mockServer>> | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const GEMINI_KEY = "AIzaSyTEST_KEY_0123456789abcdefghijklm";

describe("AI scan provider", () => {
  it("defaults to Claude and is off until a key is added", () => {
    const s = ocr.ocrStatus();
    expect(s.provider).toBe("claude");
    expect(s.ready).toBe(false);
  });

  it("switches to Gemini and remembers the choice", () => {
    ocr.setProvider("gemini");
    expect(ocr.activeProvider()).toBe("gemini");
    expect(ocr.ocrStatus().providers.gemini.label).toBe("Gemini");
  });

  it("uses OCR_PROVIDER from the environment until a choice is made in Settings", () => {
    process.env.OCR_PROVIDER = "gemini";
    expect(ocr.activeProvider()).toBe("gemini");
    ocr.setProvider("claude");
    expect(ocr.activeProvider()).toBe("claude");
  });

  it("is ready only when the chosen provider has a key", () => {
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    expect(ocr.ocrStatus().ready).toBe(false); // still on Claude
    ocr.setProvider("gemini");
    expect(ocr.ocrStatus()).toMatchObject({ ready: true, providers: { gemini: { source: "env" }, claude: { source: null } } });
  });

  it("checks, stores and removes a Gemini key without ever exposing it", async () => {
    server = await mockServer(() => ({ status: 200, body: { name: "models/gemini-flash-latest" } }));
    process.env.GEMINI_BASE_URL = server.url;
    ocr.setProvider("gemini");
    await ocr.saveApiKey("gemini", `  ${GEMINI_KEY}  `);
    expect(db.getSecret("geminiKey")).toBe(GEMINI_KEY);
    const status = ocr.ocrStatus();
    expect(status).toMatchObject({ ready: true, providers: { gemini: { source: "settings" } } });
    expect(JSON.stringify(status)).not.toContain(GEMINI_KEY);
    ocr.removeApiKey("gemini");
    expect(ocr.ocrStatus().ready).toBe(false);
  });

  it("does not store a key the provider rejects", async () => {
    server = await mockServer(() => ({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } } }));
    process.env.GEMINI_BASE_URL = server.url;
    await expect(ocr.saveApiKey("gemini", GEMINI_KEY)).rejects.toMatchObject({ kind: "config" });
    expect(db.getSecret("geminiKey")).toBeNull();
  });

  it("sends scans to the chosen provider with the stored key", async () => {
    const reply = { quality: { readable: true, problem: "" }, rows: [{ row: 3, sku: "HOT0216", count: 40, confidence: "medium", note: "" }] };
    server = await mockServer(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] }, finishReason: "STOP" }] } }));
    process.env.GEMINI_BASE_URL = server.url;
    db.setSecret("geminiKey", GEMINI_KEY);
    ocr.setProvider("gemini");
    const out = await ocr.readCountSheet([{ data: Buffer.from("x"), mediaType: "image/jpeg" }], [{ row: 3, sku: "HOT0216", name: "Insert cup" }]);
    expect(out).toEqual(reply);
    expect(server.requests[0].headers["x-goog-api-key"]).toBe(GEMINI_KEY);
    expect(ocr.scanConcurrency()).toBe(1);
  });

  it("explains how to switch on the chosen provider when it has no key", async () => {
    ocr.setProvider("gemini");
    await expect(ocr.readDeliveryNote([{ data: Buffer.from("x"), mediaType: "image/jpeg" }], [])).rejects.toMatchObject({
      kind: "config",
      message: expect.stringContaining("Gemini API key"),
    });
  });
});

describe("multi-photo count scan", () => {
  const photo = { data: Buffer.from("x"), mediaType: "image/jpeg" as const };
  const page = { quality: { readable: true, problem: "" }, rows: [{ row: 1, sku: "PM00013034", count: 8, confidence: "high", note: "" }] };

  async function setup(replies: { status: number; body: unknown }[]) {
    let i = 0;
    server = await mockServer(() => replies[Math.min(i++, replies.length - 1)]);
    process.env.GEMINI_BASE_URL = server.url;
    db.setSecret("geminiKey", GEMINI_KEY);
    ocr.setProvider("gemini");
  }
  const okReply = { status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(page) }] }, finishReason: "STOP" }] } };
  const quota = { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } } };

  it("keeps pages already read when the free limit runs out part-way", async () => {
    await setup([okReply, quota]);
    const out = await ocr.readCountPhotos([photo, photo, photo], []);
    expect(out[0]).toEqual(page);
    expect(out[1]).toMatchObject({ kind: "quota", message: "Free limit reached, try again later or enter manually." });
    expect(out[2]).toMatchObject({ kind: "quota" });
    // Gemini photos go one at a time, in order.
    expect(server!.requests).toHaveLength(3);
  });

  it("fails with the free-limit message when nothing could be read", async () => {
    await setup([quota]);
    await expect(ocr.readCountPhotos([photo, photo], [])).rejects.toMatchObject({ kind: "quota" });
  });
});
