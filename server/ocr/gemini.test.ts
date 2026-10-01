import { afterEach, describe, expect, it } from "vitest";
import { CountResult, DeliveryResult, GEMINI_QUOTA_MESSAGE, OcrError, countPrompt } from "./common.ts";
import { checkGeminiKey, geminiExtract, geminiSchema } from "./gemini.ts";
import { mockServer, type Handler } from "./mock-server.ts";

const KEY = "AIzaSyTEST_KEY_0123456789abcdefghijklm";
const image = { data: Buffer.from("fake-jpeg-bytes"), mediaType: "image/jpeg" as const };

const countReply = {
  quality: { readable: true, problem: "" },
  rows: [
    { row: 1, sku: "PM00013034", count: 12, confidence: "high", note: "" },
    { row: 2, sku: "PM00013033", count: null, confidence: "low", note: "box empty" },
  ],
};

const ok = (payload: unknown, finishReason = "STOP") => ({
  status: 200,
  body: { candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(payload) }] }, finishReason }] },
});

let server: Awaited<ReturnType<typeof mockServer>> | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function run(handler: Handler, schema: typeof CountResult | typeof DeliveryResult = CountResult) {
  server = await mockServer(handler);
  return geminiExtract<typeof schema>({ schema, images: [image], prompt: countPrompt([{ row: 1, sku: "PM00013034", name: "Pulp container" }]) }, { apiKey: KEY, baseUrl: server.url, maxRetries: 0 });
}

async function expectOcrError(p: Promise<unknown>, kind: OcrError["kind"], message?: string | RegExp) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(OcrError);
  expect(err.kind).toBe(kind);
  if (message) expect(err.message).toMatch(message);
}

describe("Gemini AI scan", () => {
  it("returns the same count format as Claude", async () => {
    const out = await run(() => ok(countReply));
    expect(out).toEqual(countReply);
  });

  it("sends the photo inline with a JSON schema and the API key", async () => {
    await run(() => ok(countReply));
    const req = server!.requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toMatch(/models\/gemini-flash-latest:generateContent/);
    expect(req.headers["x-goog-api-key"]).toBe(KEY);
    const body = req.body as {
      contents: { parts: { inlineData?: { mimeType: string; data: string }; text?: string }[] }[];
      generationConfig: { responseMimeType: string; responseJsonSchema: Record<string, unknown> };
    };
    const parts = body.contents[0].parts;
    expect(parts[0].inlineData).toEqual({ mimeType: "image/jpeg", data: image.data.toString("base64") });
    expect(parts[1].text).toContain("PM00013034");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema).toEqual(geminiSchema(CountResult));
  });

  it("reads delivery notes into the delivery format", async () => {
    const reply = {
      quality: { readable: true, problem: "" },
      supplier: "HOT PACK",
      reference: "DO-1182",
      date: "2026-10-01",
      lines: [{ code: "HOT0217", description: "LID FLAT 12/16OZ", quantity: 4, unit: "CTN", confidence: "high", note: "" }],
    };
    expect(await run(() => ok(reply), DeliveryResult)).toEqual(reply);
  });

  it("shows a friendly message when the free limit is used up (429)", async () => {
    await expectOcrError(
      run(() => ({ status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota" } } })),
      "quota",
      GEMINI_QUOTA_MESSAGE,
    );
  });

  it("does not hang retrying a quota error", async () => {
    await expectOcrError(
      run(() => ({ status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } } })),
      "quota",
    );
    expect(server!.requests).toHaveLength(1);
  });

  it("treats RESOURCE_EXHAUSTED with another status as the free limit too", async () => {
    await expectOcrError(run(() => ({ status: 403, body: { error: { code: 403, status: "RESOURCE_EXHAUSTED", message: "quota" } } })), "quota");
  });

  it("reports a rejected key as a setup problem", async () => {
    await expectOcrError(
      run(() => ({
        status: 400,
        body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } },
      })),
      "config",
      /rejected/,
    );
  });

  it("asks for a retake when the reply is cut off", async () => {
    await expectOcrError(run(() => ok(countReply, "MAX_TOKENS")), "retake", /two halves/);
  });

  it("asks for a retake when the reply is blocked", async () => {
    await expectOcrError(run(() => ({ status: 200, body: { promptFeedback: { blockReason: "SAFETY" }, candidates: [] } })), "retake");
  });

  it("rejects replies that don't match the format instead of saving bad data", async () => {
    await expectOcrError(run(() => ok({ quality: { readable: true, problem: "" }, rows: [{ row: "one", count: "12" }] })), "retake");
    await server!.close();
    server = null;
    await expectOcrError(
      run(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "{not json" }] }, finishReason: "STOP" }] } })),
      "retake",
    );
  });

  it("maps server errors to a retryable failure", async () => {
    await expectOcrError(run(() => ({ status: 500, body: { error: { code: 500, status: "INTERNAL", message: "boom" } } })), "failed", /enter manually/);
  });

  it("builds a schema Gemini accepts (no $schema, additionalProperties or numeric bounds)", () => {
    const text = JSON.stringify(geminiSchema(DeliveryResult));
    expect(text).not.toMatch(/\$schema|additionalProperties|minimum|maximum/);
    const s = geminiSchema(CountResult) as { properties: { rows: { items: { properties: Record<string, unknown>; required: string[] } } } };
    expect(s.properties.rows.items.required).toEqual(["row", "sku", "count", "confidence", "note"]);
    expect(s.properties.rows.items.properties.count).toMatchObject({ anyOf: [{ type: "number" }, { type: "null" }] });
  });
});

describe("Gemini key check", () => {
  it("accepts a key the API recognises", async () => {
    server = await mockServer(() => ({ status: 200, body: { name: "models/gemini-flash-latest" } }));
    await expect(checkGeminiKey(KEY, { baseUrl: server.url, maxRetries: 0 })).resolves.toBeUndefined();
    expect(server.requests[0].method).toBe("GET");
  });

  it("rejects a key the API refuses", async () => {
    server = await mockServer(() => ({
      status: 400,
      body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } },
    }));
    await expectOcrError(checkGeminiKey(KEY, { baseUrl: server.url, maxRetries: 0 }), "config", /Google AI Studio/);
  });

  it("rejects obviously wrong input without calling Google", async () => {
    await expectOcrError(checkGeminiKey("not a key", {}), "config");
  });
});
