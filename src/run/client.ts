/**
 * Model client abstraction. Three providers:
 *   anthropic         - official SDK (models under test and Claude judges)
 *   openai-compatible - raw fetch to {SEAM_JUDGE_BASE_URL}/chat/completions for a
 *                       non-Claude judge (Gemini/Kimi via their OpenAI-compatible endpoints)
 *   mock              - deterministic offline responses for tests and dry runs
 *
 * Deliberate choices for the experiment:
 *  - No `temperature`, `top_p`, `top_k`: the API default matches the app (and the
 *    current API version rejects them anyway).
 *  - No `thinking` parameter: current models run adaptive thinking by default,
 *    which is what the app does. Omitting it keeps every model on its default.
 *  - No server-side refusal `fallbacks`: a fallback would silently swap the
 *    responding model, which is the one variable this experiment controls. A
 *    refusal is recorded as stop_reason "refusal" and the trial is flagged.
 */
import Anthropic from "@anthropic-ai/sdk";

export type Provider = "anthropic" | "openai-compatible" | "mock";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface CompleteRequest {
  provider: Provider;
  model: string;
  system?: string;
  messages: ChatMessage[];
  max_tokens: number;
}

export interface CompleteResult {
  text: string;
  stop_reason: string | null;
  stop_details?: unknown;
  served_model: string | null;
  usage?: unknown;
  raw: unknown;
  provider: Provider;
  request_id?: string | null;
}

export type MockResponder = (req: CompleteRequest) => string;

let anthropicClient: Anthropic | null = null;
let mockResponder: MockResponder | null = null;

export function setMockResponder(fn: MockResponder | null): void {
  mockResponder = fn;
}

function anthropic(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

function toAnthropicMessages(msgs: ChatMessage[]): Anthropic.MessageParam[] {
  // Mid-conversation system messages are supported on the current models; the
  // SDK's MessageParam role union may lag, so we cast through unknown.
  return msgs.map((m) => ({ role: m.role, content: m.content })) as unknown as Anthropic.MessageParam[];
}

export async function complete(req: CompleteRequest): Promise<CompleteResult> {
  if (req.provider === "mock") {
    if (!mockResponder) throw new Error("mock provider selected but no mock responder installed");
    return { text: mockResponder(req), stop_reason: "end_turn", served_model: req.model, raw: null, provider: "mock" };
  }
  if (req.provider === "anthropic") {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.max_tokens,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.system && req.system.length > 0) params.system = req.system;
    const res = await anthropic().messages.create(params);
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return {
      text,
      stop_reason: res.stop_reason,
      stop_details: (res as unknown as { stop_details?: unknown }).stop_details ?? null,
      served_model: res.model,
      usage: res.usage,
      raw: res,
      provider: "anthropic",
      request_id: (res as unknown as { _request_id?: string })._request_id ?? null,
    };
  }
  // openai-compatible
  const base = process.env.SEAM_JUDGE_BASE_URL;
  const key = process.env.SEAM_JUDGE_API_KEY;
  if (!base || !key) throw new Error("openai-compatible provider needs SEAM_JUDGE_BASE_URL and SEAM_JUDGE_API_KEY in .env");
  const body = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
  };
  const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`judge endpoint ${r.status}: ${(await r.text()).slice(0, 500)}`);
  const j = (await r.json()) as { model?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
  const choice = j.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    stop_reason: choice?.finish_reason ?? null,
    served_model: j.model ?? req.model,
    usage: j.usage,
    raw: j,
    provider: "openai-compatible",
  };
}

/** Classify an SDK error for logging. Most specific first. */
export function describeError(e: unknown): { kind: string; status: number | null; message: string } {
  if (e instanceof Anthropic.RateLimitError) return { kind: "rate_limit", status: e.status, message: e.message };
  if (e instanceof Anthropic.AuthenticationError) return { kind: "auth", status: e.status, message: e.message };
  if (e instanceof Anthropic.BadRequestError) return { kind: "bad_request", status: e.status, message: e.message };
  if (e instanceof Anthropic.NotFoundError) return { kind: "not_found", status: e.status, message: e.message };
  if (e instanceof Anthropic.APIConnectionError) return { kind: "connection", status: null, message: e.message };
  if (e instanceof Anthropic.APIError) return { kind: "api", status: e.status ?? null, message: e.message };
  return { kind: "unknown", status: null, message: (e as Error)?.message ?? String(e) };
}

export function isRetryable(e: unknown): boolean {
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.InternalServerError) return true;
  return false;
}
