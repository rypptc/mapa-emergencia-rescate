/**
 * OCR/ICR provider client (Minimax VL) for patient imports (#151/#158).
 *
 * Calls the OpenAI-compatible `/chat/completions` endpoint with a multimodal
 * message (`image_url`) and parses the model's JSON answer into `RawPatientRow[]`
 * — the SAME shape the structured JSON/CSV/XLSX pipeline already consumes.
 *
 * INVARIANTS (humanitarian / PII):
 *   - OCR/ICR output is ADVISORY: `needsHumanReview` is ALWAYS `true`. Extracted
 *     rows must NEVER auto-apply or become "valid"/ready without human review.
 *   - The API token is NEVER logged and NEVER placed in an error message or a
 *     returned value. Errors carry only a generic, safe description + HTTP status.
 *   - The model output is UNTRUSTED: only a fixed allowlist of fields is kept
 *     (no passthrough), so a hostile/garbled completion cannot inject arbitrary
 *     or prototype-polluting keys into the pipeline.
 *
 * `fetch` is injectable so unit tests mock the request/response shape and never
 * touch the network. This module does NOT call the network at import time.
 *
 * SCOPE: this client takes an already-resolvable image URL. It does NOT decide
 * where that URL comes from. Wiring it to the ingest (persisting/uploading the
 * image, creating staging rows, enqueuing a worker job) is a separate slice that
 * needs an image storage/retention decision — see the NEEDS DECISION notes.
 */
import { MAX_IMPORT_ROWS } from "@/services/patient-import-parse";
import type { RawPatientRow } from "@/services/patient-import-logic";
import type { MinimaxOcrConfig } from "@/services/ocr/minimax-config";

/** Safe, token-free error for any OCR provider failure. Translated to 5xx upstream. */
export class MinimaxOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinimaxOcrError";
  }
}

/** Batch-level warning attached to every OCR extraction result. */
export const OCR_REVIEW_WARNING =
  "Extracted via OCR/ICR — mandatory human review required before apply.";

/** Result of an OCR/ICR extraction. `needsHumanReview` is an invariant `true`. */
export interface OcrExtractionResult {
  /** Raw rows in the same shape the structured pipeline consumes. */
  rows: RawPatientRow[];
  /** Model id actually used (echoes the parametrized config). */
  model: string;
  /** INVARIANT: OCR/ICR is advisory — always requires human review. */
  needsHumanReview: true;
  /** Batch-level warnings (origin notice). Row-level review is enforced downstream. */
  warnings: string[];
}

/** Minimal fetch contract so tests can inject a mock. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Fields we accept from the (untrusted) model output. No passthrough. */
const ALLOWED_STRING_FIELDS = [
  "name",
  "hospital",
  "hospitalId",
  "condition",
  "status",
  "documentId",
  "notes",
  "contact",
] as const;

/** Accept only http(s) URLs. Raw/base64 images need a storage/retention contract first. */
function isValidImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Call Minimax VL to extract patient rows from an image URL. Throws
 * `MinimaxOcrError` (safe, token-free) on any transport/parse failure.
 */
export async function extractPatientRowsFromImageUrl(
  config: MinimaxOcrConfig,
  imageUrl: string,
  deps: { fetch?: FetchLike } = {},
): Promise<OcrExtractionResult> {
  const doFetch = deps.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!doFetch) throw new MinimaxOcrError("No fetch implementation available.");

  const url = (imageUrl ?? "").trim();
  if (!isValidImageUrl(url)) {
    throw new MinimaxOcrError("Invalid image URL for OCR extraction.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let res: Response;
  try {
    res = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Token used ONLY here. Never logged, never echoed.
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_completion_tokens: config.maxTokens,
        temperature: 0,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: config.prompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the patient rows from this document as a JSON array." },
              { type: "image_url", image_url: { url, detail: "default" } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch {
    // Generic on purpose: the raw error could echo request headers (the token).
    throw new MinimaxOcrError("OCR provider request failed.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new MinimaxOcrError(`OCR provider returned status ${res.status}.`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new MinimaxOcrError("OCR provider returned invalid JSON.");
  }

  const content = extractMessageContent(data);
  const rows = parseRowsFromContent(content);

  return {
    rows,
    model: config.model,
    needsHumanReview: true,
    warnings: [OCR_REVIEW_WARNING],
  };
}

/** Pull `choices[0].message.content` (a string) from the completion response. */
function extractMessageContent(data: unknown): string {
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new MinimaxOcrError("OCR provider returned no choices.");
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content !== "string") {
    throw new MinimaxOcrError("OCR provider returned an unexpected message shape.");
  }
  return content;
}

/** Strip optional ```json fences and surrounding prose, returning the JSON body. */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/**
 * Parse the model's JSON array into `RawPatientRow[]`, keeping only allowlisted
 * fields (no passthrough — the model output is untrusted). Rows are capped at
 * `MAX_IMPORT_ROWS` to match the rest of the pipeline.
 */
function parseRowsFromContent(content: string): RawPatientRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(content));
  } catch {
    throw new MinimaxOcrError("OCR provider returned non-JSON content.");
  }
  if (!Array.isArray(parsed)) {
    throw new MinimaxOcrError("OCR provider did not return a JSON array of rows.");
  }
  if (parsed.length > MAX_IMPORT_ROWS) {
    throw new MinimaxOcrError(`OCR provider returned more than ${MAX_IMPORT_ROWS} rows.`);
  }

  const rows: RawPatientRow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const src = entry as Record<string, unknown>;
    const row: RawPatientRow = {};
    for (const field of ALLOWED_STRING_FIELDS) {
      const value = src[field];
      if (typeof value === "string" && value.trim() !== "") {
        (row as Record<string, unknown>)[field] = value.trim();
      }
    }
    // `age` may arrive as number or string; keep both forms (normalized later).
    const age = src.age;
    if (typeof age === "number" || (typeof age === "string" && age.trim() !== "")) {
      row.age = typeof age === "number" ? age : age.trim();
    }
    // Skip fully-empty objects so junk lines don't become staging rows.
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return rows;
}
