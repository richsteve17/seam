/**
 * Non-chronological ordering detection. The export is not guaranteed to be in
 * conversation order (Record 001: the "Flash 3.8 just did the thing" fact-check
 * sits at index 3 but is the reply to the final user message). We never
 * reorder; we emit suggestions the user confirms via `--order-file`.
 */
import type { ParsedTurn } from "./export.js";

export interface ReorderSuggestion {
  turn: number;                 // assistant turn index in the file
  suggested_after: number;      // user turn index it appears to reply to
  reason: "quoted_later_user_text" | "shared_rare_ngram_with_later_user" | "temporal_reference";
  evidence: string;
  confidence: "high" | "medium" | "low";
}

const TEMPORAL = /\b(ten|five|fifteen|twenty|\d+)\s+minutes?\s+ago\b|\bearlier (?:today|in (?:this|the) (?:thread|conversation))\b|\ba (?:few|couple of) (?:minutes|turns) ago\b/i;

function quotedStrings(text: string): string[] {
  const out: string[] = [];
  const re = /["“]([^"”]{12,200})["”]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

function ngrams(text: string, n: number): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export function detectReorder(turns: ParsedTurn[]): ReorderSuggestion[] {
  const out: ReorderSuggestion[] = [];
  const userTurns = turns.filter((t) => t.role === "user" && t.content.length > 0);
  // Count 6-gram frequency across all user turns so we only match rare ones.
  const gramCount = new Map<string, number>();
  const userGrams = new Map<number, Set<string>>();
  for (const u of userTurns) {
    const g = ngrams(u.content, 6);
    userGrams.set(u.index, g);
    for (const x of g) gramCount.set(x, (gramCount.get(x) ?? 0) + 1);
  }

  for (const t of turns) {
    if (t.role !== "assistant" || t.empty) continue;
    const later = userTurns.filter((u) => u.index > t.index);
    if (later.length === 0) continue;

    // 1) The assistant quotes text that only appears in a *later* user turn.
    for (const q of quotedStrings(t.content)) {
      const earlierHit = userTurns.some((u) => u.index < t.index && u.content.includes(q));
      if (earlierHit) continue;
      const hit = later.find((u) => u.content.includes(q));
      if (hit) {
        out.push({
          turn: t.index,
          suggested_after: hit.index,
          reason: "quoted_later_user_text",
          evidence: `assistant turn ${t.index} quotes ${JSON.stringify(q)} which first appears in user turn ${hit.index}`,
          confidence: "high",
        });
        break;
      }
    }

    // 2) Shares a rare 6-gram with a later user turn and with no earlier one.
    const tg = ngrams(t.content, 6);
    let best: { u: ParsedTurn; gram: string } | null = null;
    for (const u of later) {
      const ug = userGrams.get(u.index)!;
      for (const g of tg) {
        if (ug.has(g) && (gramCount.get(g) ?? 0) === 1) {
          best = { u, gram: g };
          break;
        }
      }
      if (best) break;
    }
    if (best && !out.some((s) => s.turn === t.index)) {
      out.push({
        turn: t.index,
        suggested_after: best.u.index,
        reason: "shared_rare_ngram_with_later_user",
        evidence: `assistant turn ${t.index} and user turn ${best.u.index} share the phrase ${JSON.stringify(best.gram)}; no earlier user turn does`,
        confidence: "medium",
      });
    }

    // 3) Temporal references to events that, by file order, have not happened yet.
    const tm = t.content.match(TEMPORAL);
    if (tm && !out.some((s) => s.turn === t.index)) {
      // Weak on its own; only report if this turn sits in the first 10% of the file.
      if (t.index < Math.max(4, turns.length * 0.1)) {
        out.push({
          turn: t.index,
          suggested_after: -1,
          reason: "temporal_reference",
          evidence: `assistant turn ${t.index} says ${JSON.stringify(tm[0])} but sits near the top of the file`,
          confidence: "low",
        });
      }
    }
  }
  return out;
}

/** Apply a user-confirmed order: an array of original indices in the confirmed sequence. */
export function applyConfirmedOrder(turns: ParsedTurn[], order: number[]): ParsedTurn[] {
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= turns.length) throw new Error(`order contains invalid index ${i}`);
    if (seen.has(i)) throw new Error(`order repeats index ${i}`);
    seen.add(i);
  }
  if (seen.size !== turns.length) throw new Error(`order has ${seen.size} indices, transcript has ${turns.length}`);
  return order.map((i) => turns[i]);
}
