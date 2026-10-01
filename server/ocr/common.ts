// Shared pieces of AI scan: error type, image input, and the output schemas
// both providers must fill. The rest of the app only ever sees these shapes.
import { z } from "zod";

export type OcrErrorKind = "config" | "retake" | "failed" | "quota";

export class OcrError extends Error {
  constructor(message: string, readonly kind: OcrErrorKind) {
    super(message);
  }
}

export const GEMINI_QUOTA_MESSAGE = "Free limit reached, try again later or enter manually.";
export const CLAUDE_QUOTA_MESSAGE = "Claude rate limit reached, try again in a minute or enter manually.";

export interface ImageInput {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

const Quality = z.object({
  readable: z.boolean().describe("false if the photo is too blurry, dark, cropped, angled or glared to read reliably"),
  problem: z.string().describe("short, practical retake advice if not readable, else empty string"),
});

export const CountResult = z.object({
  quality: Quality,
  rows: z.array(
    z.object({
      row: z.number().int().describe("the printed row number (# column)"),
      sku: z.string().describe("the printed SKU code on that row, as printed"),
      count: z.number().nullable().describe("the handwritten count; null if the box is empty or illegible"),
      confidence: z.enum(["high", "medium", "low"]),
      note: z.string().describe("anything ambiguous, e.g. 'could be 7 or 1', 'crossed out 5, wrote 8'; else empty"),
    }),
  ),
});
export type CountOcr = z.infer<typeof CountResult>;

export const DeliveryResult = z.object({
  quality: Quality,
  supplier: z.string().describe("supplier name on the note, or empty"),
  reference: z.string().describe("delivery note / invoice / DO number, or empty"),
  date: z.string().describe("delivery date as YYYY-MM-DD if printed, else empty"),
  lines: z.array(
    z.object({
      code: z.string().describe("item code / SKU / part number on the line, or empty"),
      description: z.string(),
      quantity: z.number().nullable().describe("delivered quantity; prefer a handwritten 'received' correction over the printed figure"),
      unit: z.string().describe("unit as written, e.g. CTN, PCS, BOX, ROLL; empty if none"),
      confidence: z.enum(["high", "medium", "low"]),
      note: z.string().describe("e.g. 'printed 20, handwritten received 18'; else empty"),
    }),
  ),
});
export type DeliveryOcr = z.infer<typeof DeliveryResult>;

/** One extraction request, independent of the provider. */
export interface ExtractRequest<T extends z.ZodTypeAny> {
  schema: T;
  images: ImageInput[];
  prompt: string;
}

export interface ProviderOptions {
  apiKey?: string | null; // null/undefined = provider's environment variable
  model?: string;
  baseUrl?: string;
  maxRetries?: number;
}

/** Validate a provider's JSON against the schema; anything off is treated as an unreadable photo. */
export function validateOutput<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new OcrError("The scan came back incomplete. Please retake the photo or enter the numbers manually.", "retake");
  return parsed.data;
}

export function countPrompt(sheetRows: { row: number; sku: string; name: string }[]): string {
  const list = sheetRows.map((r) => `${r.row}\t${r.sku}\t${r.name}`).join("\n");
  return `These photos show pages of a printed daily packaging inventory count sheet. Each printed row has a row number (#), a SKU code and an item name; the stock controller has handwritten the physical count in the "Count" box.

Read the handwritten count for every row that is visible. Use the printed row number and SKU to identify the row; the printed rows are listed below for reference. Do not invent values: if a box is empty, write null; if a digit is unclear, give your best reading with confidence "low" and explain in note. Watch for common handwriting confusions (1/7, 4/9, 5/6, 0/6) and for crossed-out corrections (use the final value).

If a photo is too blurry, dark, cut off or at too steep an angle to read most of the rows reliably, set quality.readable to false and give short retake advice.

Printed rows (# <tab> SKU <tab> name):
${list}`;
}

export function deliveryPrompt(knownItems: { sku: string; name: string }[]): string {
  const list = knownItems.map((r) => `${r.sku}\t${r.name}`).join("\n");
  return `These photos show a supplier delivery note (or several pages of one). Extract every delivered line item with its code, description, delivered quantity and unit. Include handwritten corrections of received quantities if present (use the received figure and mention the printed one in note). Skip totals, taxes and prices.

If a photo is too blurry, dark, cut off or angled to read the lines reliably, set quality.readable to false and give short retake advice.

For reference, these are the packaging items we stock (SKU <tab> name); suppliers may use their own codes and names:
${list}`;
}
