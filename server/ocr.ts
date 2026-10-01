// Reads handwritten count sheets and delivery notes with Claude vision.
// Nothing here writes to the database: results always go back to the
// controller for confirmation first.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const MODEL = process.env.OCR_MODEL ?? "claude-opus-5-5";

let client: Anthropic | null = null;
export function ocrAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
function anthropic(): Anthropic {
  if (!ocrAvailable()) throw new OcrError("OCR is not configured. Set ANTHROPIC_API_KEY on the server, or type the numbers in manually.", "config");
  client ??= new Anthropic();
  return client;
}

export class OcrError extends Error {
  constructor(message: string, readonly kind: "config" | "retake" | "failed") {
    super(message);
  }
}

export interface ImageInput {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

const Quality = z.object({
  readable: z.boolean().describe("false if the photo is too blurry, dark, cropped, angled or glared to read reliably"),
  problem: z.string().describe("short, practical retake advice if not readable, else empty string"),
});

const CountResult = z.object({
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

const DeliveryResult = z.object({
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

function imageBlocks(images: ImageInput[]): Anthropic.ImageBlockParam[] {
  return images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data.toString("base64") },
  }));
}

async function extract<T extends z.ZodTypeAny>(schema: T, images: ImageInput[], instructions: string): Promise<z.infer<T>> {
  let response;
  try {
    response = await anthropic().messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "high", format: zodOutputFormat(schema) },
      messages: [{ role: "user", content: [...imageBlocks(images), { type: "text", text: instructions }] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new OcrError("The OCR service is busy. Try again in a minute.", "failed");
    if (e instanceof Anthropic.AuthenticationError) throw new OcrError("The OCR API key was rejected. Check ANTHROPIC_API_KEY.", "config");
    if (e instanceof Anthropic.BadRequestError) throw new OcrError("The photo could not be processed. Please retake it as a JPEG.", "retake");
    if (e instanceof Anthropic.APIError) throw new OcrError(`OCR failed (${e.status ?? "network"}). Try again.`, "failed");
    throw e;
  }
  if (response.stop_reason === "refusal") throw new OcrError("The photo could not be read. Please retake it.", "retake");
  if (response.stop_reason === "max_tokens") throw new OcrError("Too much on one photo. Photograph the sheet in two halves.", "retake");
  if (!response.parsed_output) throw new OcrError("Could not read the photo. Please retake it.", "retake");
  return response.parsed_output as z.infer<T>;
}

export async function readCountSheet(
  images: ImageInput[],
  sheetRows: { row: number; sku: string; name: string }[],
): Promise<CountOcr> {
  const list = sheetRows.map((r) => `${r.row}\t${r.sku}\t${r.name}`).join("\n");
  return extract(
    CountResult,
    images,
    `These photos show pages of a printed daily packaging inventory count sheet. Each printed row has a row number (#), a SKU code and an item name; the stock controller has handwritten the physical count in the "Count" box.

Read the handwritten count for every row that is visible. Use the printed row number and SKU to identify the row; the printed rows are listed below for reference. Do not invent values: if a box is empty, write null; if a digit is unclear, give your best reading with confidence "low" and explain in note. Watch for common handwriting confusions (1/7, 4/9, 5/6, 0/6) and for crossed-out corrections (use the final value).

If a photo is too blurry, dark, cut off or at too steep an angle to read most of the rows reliably, set quality.readable to false and give short retake advice.

Printed rows (# <tab> SKU <tab> name):
${list}`,
  );
}

export async function readDeliveryNote(images: ImageInput[], knownItems: { sku: string; name: string }[]): Promise<DeliveryOcr> {
  const list = knownItems.map((r) => `${r.sku}\t${r.name}`).join("\n");
  return extract(
    DeliveryResult,
    images,
    `These photos show a supplier delivery note (or several pages of one). Extract every delivered line item with its code, description, delivered quantity and unit. Include handwritten corrections of received quantities if present (use the received figure and mention the printed one in note). Skip totals, taxes and prices.

If a photo is too blurry, dark, cut off or angled to read the lines reliably, set quality.readable to false and give short retake advice.

For reference, these are the packaging items we stock (SKU <tab> name); suppliers may use their own codes and names:
${list}`,
  );
}
