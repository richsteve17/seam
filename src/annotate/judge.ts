/**
 * Optional LLM judge second pass over a transcript. The judge reads the rubric
 * (judge/rubric.md), the preceding user turn and the assistant turn, and
 * returns JSON with verbatim quotes for each field. Regex hits are kept; judge
 * hits are added with source "judge". The judge model is recorded on the record.
 */
import fs from "node:fs";
import path from "node:path";
import type { ParsedTurn } from "../parse/export.js";
import type { TurnAnnotation } from "./types.js";
import type { Quote } from "./regex.js";
import { complete, type Provider } from "../run/client.js";
import { buildPatterns } from "./annotate.js";
import { modelMentions } from "./regex.js";
import type { SeamConfig } from "../config.js";

export interface JudgeSpec {
  model: string;
  provider: Provider;
}

const FIELDS = ["ownership_claims", "disownments", "identity_self_reports", "mechanism_self_reports", "self_corrections"] as const;

export function loadRubric(root: string): string {
  return fs.readFileSync(path.join(root, "judge", "rubric.md"), "utf8");
}

export function judgeSystemPrompt(rubric: string): string {
  return [
    "You are a transcript annotator for a research project on model handoffs. Follow the rubric exactly.",
    "Return ONLY a JSON object, no prose, with keys: ownership_claims, disownments, identity_self_reports, mechanism_self_reports, self_corrections.",
    "Each value is an array of objects {\"quote\": <verbatim sentence copied from the ASSISTANT turn>, \"model_named\": <model name string or null>}.",
    "Quotes must be copied verbatim from the assistant turn; never paraphrase. Empty arrays are fine and expected.",
    "",
    "RUBRIC:",
    rubric,
  ].join("\n");
}

export function parseJudgeJson(text: string): Record<string, Array<{ quote: string; model_named?: string | null }>> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("judge returned no JSON object");
  const j = JSON.parse(m[0]) as Record<string, unknown>;
  const out: Record<string, Array<{ quote: string; model_named?: string | null }>> = {};
  for (const f of FIELDS) {
    const v = j[f];
    out[f] = Array.isArray(v) ? v.filter((x) => x && typeof x.quote === "string") : [];
  }
  return out;
}

export async function judgeTurns(
  turns: ParsedTurn[],
  ann: TurnAnnotation[],
  cfg: SeamConfig,
  judge: JudgeSpec,
  opts: { only?: number[]; log?: (s: string) => void } = {},
): Promise<void> {
  const rubric = loadRubric(cfg.root);
  const system = judgeSystemPrompt(rubric);
  const cp = buildPatterns(cfg);
  const byIndex = new Map(turns.map((t) => [t.index, t]));
  for (const a of ann) {
    if (a.role !== "assistant") continue;
    if (opts.only && !opts.only.includes(a.index)) continue;
    const t = byIndex.get(a.index)!;
    if (t.empty) continue;
    const prevUser = turns.filter((x) => x.role === "user" && x.index < a.index).at(-1);
    const prevAssistant = turns.filter((x) => x.role === "assistant" && x.index < a.index && !x.empty).at(-1);
    const user = [
      prevAssistant ? `PRIOR ASSISTANT TURN (index ${prevAssistant.index}):\n${prevAssistant.content.slice(0, 4000)}` : "PRIOR ASSISTANT TURN: (none)",
      prevUser ? `PRECEDING USER TURN (index ${prevUser.index}):\n${prevUser.content.slice(0, 4000)}` : "PRECEDING USER TURN: (none)",
      `ASSISTANT TURN TO ANNOTATE (index ${a.index}):\n${t.content}`,
    ].join("\n\n");
    opts.log?.(`judge: turn ${a.index}`);
    const res = await complete({ provider: judge.provider, model: judge.model, system, messages: [{ role: "user", content: user }], max_tokens: 4000 });
    let parsed: ReturnType<typeof parseJudgeJson>;
    try {
      parsed = parseJudgeJson(res.text);
    } catch (e) {
      opts.log?.(`judge: turn ${a.index}: unparseable output (${(e as Error).message}); skipped`);
      continue;
    }
    for (const f of FIELDS) {
      for (const hit of parsed[f]) {
        if (!t.content.includes(hit.quote.trim())) continue; // judge must quote verbatim
        if (a[f].some((q) => q.quote === hit.quote.trim())) continue;
        const q: Quote = {
          quote: hit.quote.trim(),
          match: hit.quote.trim(),
          pattern: `judge:${judge.model}`,
          source: "judge",
          model_ref: hit.model_named ? cp.lookupModel(hit.model_named) ?? modelMentions(hit.quote, cp).find((m) => m.id)?.id ?? null : modelMentions(hit.quote, cp).find((m) => m.id)?.id ?? null,
        };
        a[f].push(q);
        if (f === "identity_self_reports" && !a.claimed_model && q.model_ref) {
          a.claimed_model = q.model_ref;
          a.claimed_model_quote = q.quote;
        }
      }
    }
  }
}
