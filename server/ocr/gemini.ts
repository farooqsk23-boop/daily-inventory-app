// AI scan via Google Gemini (Gemini API / AI Studio keys) with JSON-schema output.
// Uses the same zod schemas as Claude and validates the reply against them, so
// the rest of the app gets exactly the same shapes.
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { GEMINI_QUOTA_MESSAGE, OcrError, validateOutput, type ExtractRequest, type ProviderOptions } from "./common.ts";

// "-latest" alias follows Google's current Flash model, so the default doesn't go stale.
export const GEMINI_DEFAULT_MODEL = "gemini-flash-latest";

function client(opts: ProviderOptions): GoogleGenAI {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new OcrError("No Gemini API key. Add one in Settings → AI scan.", "config");
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      timeout: 120_000,
      // Retry server hiccups once; never retry 429 so a used-up free quota fails fast.
      retryOptions: { attempts: 1 + (opts.maxRetries ?? 1), httpStatusCodes: [500, 502, 503, 504] },
    },
  });
}

const KEEP = new Set(["type", "properties", "required", "items", "enum", "description", "anyOf", "nullable", "format", "propertyOrdering"]);

/**
 * JSON schema for Gemini's responseJsonSchema: the zod schema converted, keeping only
 * the widely supported keywords (no $schema, additionalProperties or numeric bounds).
 */
export function geminiSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (!KEEP.has(k)) continue;
      // ["number", "null"] -> anyOf, the nullable form Gemini documents.
      if (k === "type" && Array.isArray(v)) {
        out.anyOf = v.map((t) => ({ type: t }));
        continue;
      }
      if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, clean(s)]));
      else out[k] = clean(v);
    }
    return out;
  };
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function errorBody(e: ApiError): { status?: string; message?: string; reasons: string[] } {
  try {
    const body = JSON.parse(e.message) as { error?: { status?: string; message?: string; details?: { reason?: string }[] } };
    return {
      status: body.error?.status,
      message: body.error?.message,
      reasons: (body.error?.details ?? []).map((d) => d.reason ?? "").filter(Boolean),
    };
  } catch {
    return { reasons: [] };
  }
}

/** Translate Gemini API errors into the app's error kinds. */
export function mapGeminiError(e: unknown, context: "scan" | "key" = "scan"): never {
  if (e instanceof OcrError) throw e;
  if (e instanceof ApiError) {
    const b = errorBody(e);
    if (e.status === 429 || b.status === "RESOURCE_EXHAUSTED") throw new OcrError(GEMINI_QUOTA_MESSAGE, "quota");
    const keyProblem =
      e.status === 401 ||
      e.status === 403 ||
      b.reasons.includes("API_KEY_INVALID") ||
      /api key (not valid|expired|invalid)/i.test(b.message ?? "");
    if (keyProblem)
      throw new OcrError(context === "key" ? "The key was rejected. Check it in Google AI Studio and paste it again." : "The Gemini API key was rejected. Check it in Settings → AI scan.", "config");
    if (e.status === 404) throw new OcrError("This Gemini key can't use the scan model.", "config");
    if (e.status === 400 && context === "scan") throw new OcrError("Gemini could not process the photo. Please retake it as a JPEG or enter manually.", "retake");
    throw new OcrError(`${context === "key" ? "Could not check the key" : "AI scan failed"} (${e.status}). Try again${context === "scan" ? " or enter manually" : ""}.`, "failed");
  }
  throw new OcrError(`${context === "key" ? "Could not check the key" : "AI scan failed"} (network). Try again.`, "failed");
}

const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "LANGUAGE", "OTHER"]);

export async function geminiExtract<T extends z.ZodTypeAny>(req: ExtractRequest<T>, opts: ProviderOptions = {}): Promise<z.infer<T>> {
  const ai = client(opts);
  let response;
  try {
    response = await ai.models.generateContent({
      model: opts.model ?? GEMINI_DEFAULT_MODEL,
      contents: [
        {
          role: "user",
          parts: [...req.images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data.toString("base64") } })), { text: req.prompt }],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: geminiSchema(req.schema),
        maxOutputTokens: 16384,
      },
    });
  } catch (e) {
    mapGeminiError(e);
  }
  if (response.promptFeedback?.blockReason) throw new OcrError("The photo could not be read. Please retake it.", "retake");
  const finish = response.candidates?.[0]?.finishReason;
  if (finish === "MAX_TOKENS") throw new OcrError("Too much on one photo. Photograph the sheet in two halves.", "retake");
  if (finish && BLOCKED.has(finish)) throw new OcrError("The photo could not be read. Please retake it.", "retake");
  const text = response.text;
  if (!text) throw new OcrError("Could not read the photo. Please retake it.", "retake");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OcrError("The scan came back incomplete. Please retake the photo or enter the numbers manually.", "retake");
  }
  return validateOutput(req.schema, raw);
}

/** Checks a key by looking up the model (no tokens used). */
export async function checkGeminiKey(key: string, opts: ProviderOptions = {}): Promise<void> {
  if (!/^[\w-]{20,}$/.test(key)) throw new OcrError("That doesn't look like a Gemini API key (from aistudio.google.com, usually starting with AIza).", "config");
  try {
    await client({ ...opts, apiKey: key }).models.get({ model: opts.model ?? GEMINI_DEFAULT_MODEL });
  } catch (e) {
    mapGeminiError(e, "key");
  }
}
