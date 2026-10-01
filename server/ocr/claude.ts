// AI scan via Claude (Anthropic API) with structured outputs.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { CLAUDE_QUOTA_MESSAGE, OcrError, validateOutput, type ExtractRequest, type ProviderOptions } from "./common.ts";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

function client(opts: ProviderOptions): Anthropic {
  return new Anthropic({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    ...(opts.maxRetries != null ? { maxRetries: opts.maxRetries } : {}),
  });
}

function mapError(e: unknown): never {
  if (e instanceof Anthropic.RateLimitError) throw new OcrError(CLAUDE_QUOTA_MESSAGE, "quota");
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    throw new OcrError("The Claude API key was rejected. Check it in Settings → AI scan.", "config");
  if (e instanceof Anthropic.NotFoundError) throw new OcrError("This Claude key can't use the scan model.", "config");
  if (e instanceof Anthropic.BadRequestError) throw new OcrError("The photo could not be processed. Please retake it as a JPEG.", "retake");
  if (e instanceof Anthropic.APIError) throw new OcrError(`AI scan failed (${e.status ?? "network"}). Try again or enter manually.`, "failed");
  // Anything else is the SDK failing to parse the answer (e.g. cut off mid-JSON).
  throw new OcrError("The scan came back incomplete. Please retake the photo or enter the numbers manually.", "retake");
}

export async function claudeExtract<T extends z.ZodTypeAny>(req: ExtractRequest<T>, opts: ProviderOptions = {}): Promise<z.infer<T>> {
  let response;
  try {
    response = await client(opts).messages.parse({
      model: opts.model ?? CLAUDE_DEFAULT_MODEL,
      max_tokens: 16000,
      output_config: { effort: "high", format: zodOutputFormat(req.schema) },
      messages: [
        {
          role: "user",
          content: [
            ...req.images.map((img) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: img.mediaType, data: img.data.toString("base64") },
            })),
            { type: "text", text: req.prompt },
          ],
        },
      ],
    });
  } catch (e) {
    mapError(e);
  }
  if (response.stop_reason === "refusal") throw new OcrError("The photo could not be read. Please retake it.", "retake");
  if (response.stop_reason === "max_tokens") throw new OcrError("Too much on one photo. Photograph the sheet in two halves.", "retake");
  if (!response.parsed_output) throw new OcrError("Could not read the photo. Please retake it.", "retake");
  return validateOutput(req.schema, response.parsed_output);
}

/** Checks a key without generating anything (no tokens used). */
export async function checkClaudeKey(key: string, opts: ProviderOptions = {}): Promise<void> {
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw new OcrError("That doesn't look like a Claude API key (it starts with sk-ant-).", "config");
  try {
    await client({ ...opts, apiKey: key, maxRetries: opts.maxRetries ?? 1 }).models.retrieve(opts.model ?? CLAUDE_DEFAULT_MODEL);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
      throw new OcrError("The key was rejected. Check it in the Claude Console and paste it again.", "config");
    if (e instanceof Anthropic.NotFoundError) throw new OcrError("This key can't use the scan model.", "config");
    if (e instanceof Anthropic.APIError) throw new OcrError(`Could not check the key (${e.status ?? "network"}). Try again.`, "failed");
    throw e;
  }
}
