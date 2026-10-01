// AI scan: reads handwritten count sheets and delivery notes from photos with
// the provider chosen in Settings (Claude or Gemini). Nothing here writes to the
// database: results always go back to the controller for confirmation first.
import type { z } from "zod";
import { get, getSecret, run, setSecret } from "../db.ts";
import { checkClaudeKey, claudeExtract, CLAUDE_DEFAULT_MODEL } from "./claude.ts";
import {
  CountResult,
  countPrompt,
  DeliveryResult,
  deliveryPrompt,
  OcrError,
  type CountOcr,
  type DeliveryOcr,
  type ExtractRequest,
  type ImageInput,
  type ProviderOptions,
} from "./common.ts";
import { checkGeminiKey, geminiExtract, GEMINI_DEFAULT_MODEL } from "./gemini.ts";

export { OcrError, type CountOcr, type DeliveryOcr, type ImageInput } from "./common.ts";

export const PROVIDERS = ["claude", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (p: unknown): p is Provider => PROVIDERS.includes(p as Provider);

interface ProviderImpl {
  label: string;
  secret: string; // settings key holding the pasted API key
  envKey: () => boolean;
  model: () => string;
  baseUrl: () => string | undefined;
  extract: <T extends z.ZodTypeAny>(req: ExtractRequest<T>, opts: ProviderOptions) => Promise<z.infer<T>>;
  checkKey: (key: string, opts: ProviderOptions) => Promise<void>;
}

const IMPL: Record<Provider, ProviderImpl> = {
  claude: {
    label: "Claude",
    secret: "anthropicKey",
    envKey: () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    model: () => process.env.OCR_MODEL || CLAUDE_DEFAULT_MODEL,
    baseUrl: () => undefined, // the Anthropic SDK reads ANTHROPIC_BASE_URL itself
    extract: claudeExtract,
    checkKey: checkClaudeKey,
  },
  gemini: {
    label: "Gemini",
    secret: "geminiKey",
    envKey: () => !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    model: () => process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL,
    baseUrl: () => process.env.GEMINI_BASE_URL || undefined,
    extract: geminiExtract,
    checkKey: checkGeminiKey,
  },
};

// ---------- provider choice and keys ----------

const PROVIDER_SETTING = "meta:ocrProvider";

export function activeProvider(): Provider {
  const stored = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", PROVIDER_SETTING);
  const v = stored ? JSON.parse(stored.value) : process.env.OCR_PROVIDER;
  return isProvider(v) ? v : "claude";
}

export function setProvider(p: Provider) {
  run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", PROVIDER_SETTING, JSON.stringify(p));
}

/** Where a provider's key comes from: the environment, Settings, or nowhere yet. */
export function keySource(p: Provider): "env" | "settings" | null {
  if (IMPL[p].envKey()) return "env";
  return getSecret(IMPL[p].secret) ? "settings" : null;
}

export function ocrAvailable(): boolean {
  return keySource(activeProvider()) !== null;
}

export function ocrStatus() {
  const provider = activeProvider();
  return {
    provider,
    ready: keySource(provider) !== null,
    providers: Object.fromEntries(PROVIDERS.map((p) => [p, { label: IMPL[p].label, source: keySource(p), model: IMPL[p].model() }])) as Record<
      Provider,
      { label: string; source: "env" | "settings" | null; model: string }
    >,
  };
}

function options(p: Provider): ProviderOptions {
  const source = keySource(p);
  return {
    apiKey: source === "settings" ? getSecret(IMPL[p].secret) : null,
    model: IMPL[p].model(),
    baseUrl: IMPL[p].baseUrl(),
  };
}

/** Checks a key against the provider (no tokens used) and stores it server-side. */
export async function saveApiKey(p: Provider, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new OcrError("Paste the API key first.", "config");
  await IMPL[p].checkKey(trimmed, { model: IMPL[p].model(), baseUrl: IMPL[p].baseUrl() });
  setSecret(IMPL[p].secret, trimmed);
}

export function removeApiKey(p: Provider) {
  run("DELETE FROM settings WHERE key = ?", `secret:${IMPL[p].secret}`);
}

// ---------- scanning ----------

async function extract<T extends z.ZodTypeAny>(req: ExtractRequest<T>): Promise<z.infer<T>> {
  const p = activeProvider();
  if (!keySource(p)) throw new OcrError(`AI scan is not switched on yet. Add your ${IMPL[p].label} API key in Settings → AI scan, or type the numbers in.`, "config");
  return IMPL[p].extract(req, options(p));
}

/** Gemini's free tier allows only a few requests per minute, so send its photos one at a time. */
export function scanConcurrency(): number {
  return activeProvider() === "gemini" ? 1 : 4;
}

export function readCountSheet(images: ImageInput[], sheetRows: { row: number; sku: string; name: string }[]): Promise<CountOcr> {
  return extract({ schema: CountResult, images, prompt: countPrompt(sheetRows) });
}

/**
 * Scans count-sheet photos one request per photo, so a single bad photo can be
 * retaken on its own. If the scan limit runs out part-way, the photos already
 * read are kept and the rest come back as errors for manual entry. Throws only
 * when no photo could be read at all (or AI scan isn't set up).
 */
export async function readCountPhotos(images: ImageInput[], sheetRows: { row: number; sku: string; name: string }[]): Promise<(CountOcr | OcrError)[]> {
  const results: (CountOcr | OcrError)[] = new Array(images.length);
  let next = 0;
  const worker = async () => {
    while (next < images.length) {
      const i = next++;
      try {
        results[i] = await readCountSheet([images[i]], sheetRows);
      } catch (e) {
        if (!(e instanceof OcrError) || e.kind === "config") throw e;
        results[i] = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(scanConcurrency(), images.length) }, worker));
  if (results.every((r) => r instanceof OcrError)) throw results.find((r) => (r as OcrError).kind === "quota") ?? results[0];
  return results;
}

export function readDeliveryNote(images: ImageInput[], knownItems: { sku: string; name: string }[]): Promise<DeliveryOcr> {
  return extract({ schema: DeliveryResult, images, prompt: deliveryPrompt(knownItems) });
}
