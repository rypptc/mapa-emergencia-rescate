/**
 * OCR/ICR provider configuration (Minimax VL) for patient imports (#151/#158).
 *
 * FULLY PARAMETERIZED and DISABLED BY DEFAULT. The provider is OpenAI-compatible
 * (`/v1/chat/completions`, multimodal `image_url`). Token, base URL, model,
 * prompt, max tokens and timeout all come from env. When `MINIMAX_API_KEY` is
 * absent, `getMinimaxOcrConfig` returns `null` and the OCR/ICR ingest stays
 * disabled (the route keeps responding 501) — no provider is ever constructed.
 *
 * PRIVACY: the API key is server-side only. It lives in this config object and is
 * consumed by `minimax-provider.ts` to build the Authorization header. It is
 * NEVER logged and NEVER serialized into an API response or an error message.
 *
 * This module is intentionally isolated and side-effect free (besides reading
 * env). It does NOT wire OCR into the request path: turning extracted rows into
 * staging rows requires a worker job + an image storage/retention decision (see
 * the NEEDS DECISION notes in the PR). Until then this is a tested unit only.
 */
import { env } from "@/config/env";

/** Resolved, validated OCR provider config. Present only when enabled. */
export interface MinimaxOcrConfig {
  /** Bearer token. Server-side only — never logged or returned. */
  apiKey: string;
  /** OpenAI-compatible base URL (no trailing slash). `/chat/completions` appended. */
  baseUrl: string;
  /** Vision/VL model id. Parametrizable so the model can change without a deploy. */
  model: string;
  /** Upper bound on generated tokens for the extraction completion. */
  maxTokens: number;
  /** Request timeout (ms) — the provider aborts past this. */
  timeoutMs: number;
  /** System prompt that constrains the model to JSON-only patient extraction. */
  prompt: string;
}

/** Subset of env this config reads. Injectable so tests don't touch real env. */
export interface MinimaxEnvSource {
  MINIMAX_API_KEY?: string;
  MINIMAX_OCR_BASE_URL: string;
  MINIMAX_OCR_MODEL: string;
  MINIMAX_OCR_MAX_TOKENS: number;
  MINIMAX_OCR_TIMEOUT_MS: number;
  MINIMAX_OCR_PROMPT?: string;
}

/**
 * Default extraction prompt. Instructs the model to return a JSON array of
 * patient rows and NOTHING else. The output is explicitly advisory: OCR/ICR
 * (especially handwriting) is never trusted to be applied automatically — every
 * extracted row requires mandatory human review downstream.
 */
export const DEFAULT_OCR_PROMPT = [
  "You extract structured patient data from a scanned hospital document image.",
  "Return ONLY a JSON array (no prose, no code fences). Each element is an object",
  'with any of these optional string fields: "name", "hospital", "hospitalId",',
  '"age", "condition", "status", "documentId", "notes", "contact".',
  "Omit any field you cannot read confidently. Do not invent data. If the image",
  "has no readable patient data, return an empty array [].",
  "This output is advisory only and will be reviewed by a human before use.",
].join(" ");

/**
 * Resolve the OCR provider config from env (or an injected source). Returns
 * `null` when disabled — i.e. when no API key is configured. Callers MUST treat
 * `null` as "OCR/ICR not available" and keep the 501 contract.
 */
export function getMinimaxOcrConfig(source: MinimaxEnvSource = env): MinimaxOcrConfig | null {
  const apiKey = source.MINIMAX_API_KEY?.trim();
  if (!apiKey) return null; // disabled by default — no token, no provider

  const prompt = source.MINIMAX_OCR_PROMPT?.trim();
  return {
    apiKey,
    baseUrl: source.MINIMAX_OCR_BASE_URL.replace(/\/+$/, ""),
    model: source.MINIMAX_OCR_MODEL,
    maxTokens: source.MINIMAX_OCR_MAX_TOKENS,
    timeoutMs: source.MINIMAX_OCR_TIMEOUT_MS,
    prompt: prompt && prompt.length > 0 ? prompt : DEFAULT_OCR_PROMPT,
  };
}

/** Whether OCR/ICR extraction is enabled (a token is configured). */
export function isMinimaxOcrEnabled(source: MinimaxEnvSource = env): boolean {
  return getMinimaxOcrConfig(source) !== null;
}
