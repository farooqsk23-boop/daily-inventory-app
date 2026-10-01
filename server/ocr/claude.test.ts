import { afterEach, describe, expect, it } from "vitest";
import { claudeExtract } from "./claude.ts";
import { CLAUDE_QUOTA_MESSAGE, CountResult, OcrError, countPrompt } from "./common.ts";
import { mockServer, type Handler } from "./mock-server.ts";

const KEY = "sk-ant-api03-TESTKEY_0123456789abcdefghij";
const image = { data: Buffer.from("fake-jpeg-bytes"), mediaType: "image/jpeg" as const };
const countReply = {
  quality: { readable: true, problem: "" },
  rows: [{ row: 1, sku: "PM00013034", count: 12, confidence: "high", note: "" }],
};
const message = (text: string, stop_reason = "end_turn") => ({
  status: 200,
  body: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  },
});

let server: Awaited<ReturnType<typeof mockServer>> | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function run(handler: Handler) {
  server = await mockServer(handler);
  return claudeExtract({ schema: CountResult, images: [image], prompt: countPrompt([]) }, { apiKey: KEY, baseUrl: server.url, maxRetries: 0 });
}

describe("Claude AI scan", () => {
  it("returns the count format", async () => {
    expect(await run(() => message(JSON.stringify(countReply)))).toEqual(countReply);
    const body = server!.requests[0].body as { messages: { content: { type: string; source?: { data: string } }[] }[] };
    expect(body.messages[0].content[0]).toMatchObject({ type: "image", source: { data: image.data.toString("base64") } });
  });

  it("maps a rate limit to the same friendly 'enter manually' path", async () => {
    const err = await run(() => ({ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } })).catch((e) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect(err.kind).toBe("quota");
    expect(err.message).toBe(CLAUDE_QUOTA_MESSAGE);
  });

  it("asks for a retake when the answer is cut off", async () => {
    const err = await run(() => message(JSON.stringify(countReply).slice(0, 20), "max_tokens")).catch((e) => e);
    expect(err.kind).toBe("retake");
  });
});
