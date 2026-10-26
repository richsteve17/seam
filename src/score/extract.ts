/**
 * Answer extraction. Never guesses: returns null (and the caller flags the
 * trial) when no answer can be read.
 */
import type { Question } from "../config.js";

export interface Extraction {
  answer: string | number | null;
  method: string | null;
  reason?: string;
}

const RANGE = /\b(?:1|one)\s*(?:–|-|to|—)\s*10\b/gi; // "1–10" scale echoes are not answers

export function extractNumeric(text: string, scale: [number, number] = [1, 10]): Extraction {
  const [lo, hi] = scale;
  const inRange = (n: number) => Number.isInteger(n) && n >= lo && n <= hi;
  const t = text.replace(RANGE, " ");
  const strategies: Array<[string, RegExp]> = [
    ["leading_number", /^\s*[*_#>\s]*\**\s*(\d{1,2})(?:\s*\/\s*10)?\s*[.:!*_)\-—–,\s]/],
    ["leading_bold_number", /^\s*\*\*\s*(\d{1,2})\s*(?:\/\s*10)?\s*\*\*/],
    ["x_out_of_10", /\b(\d{1,2})\s*(?:\/|out of)\s*10\b/i],
    ["a_number_phrase", /\b(?:it'?s|its|i'?d (?:say|go|give it|put it at)|i (?:say|give|put it at|go with)|rating|score|answer|number)(?:\s+(?:a|an|is|at|of|:))?\s*:?\s*(\d{1,2})\b/i],
    ["first_standalone_integer", /(?<![\d.])(\d{1,2})(?!\d|\.\d|%)/],
  ];
  for (const [method, re] of strategies) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (inRange(n)) return { answer: n, method };
    }
  }
  return { answer: null, method: null, reason: `no integer in [${lo},${hi}] found` };
}

export function extractBinary(text: string, q: Question): Extraction {
  const options = q.options ?? [];
  const hits: Array<{ option: string; index: number }> = [];
  for (const opt of options) {
    const src = q.option_patterns?.[opt] ?? opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = text.match(new RegExp(src, "i"));
    if (m && m.index !== undefined) hits.push({ option: opt, index: m.index });
  }
  if (!hits.length) return { answer: null, method: null, reason: `none of ${options.join("/")} found` };
  hits.sort((a, b) => a.index - b.index);
  if (hits.length > 1 && hits[0].index === hits[1].index) return { answer: null, method: null, reason: "ambiguous: two options at the same position" };
  // If the first option appears only inside a negation ("not the laugh track") within the first 60 chars, still take it:
  // the forced-choice instruction says "one word first", so position is the rule. We record the method so it can be audited.
  return { answer: hits[0].option, method: hits.length > 1 ? "earliest_of_multiple_options" : "only_option_present" };
}

export function extractAnswer(text: string, q: Question): Extraction {
  if (q.kind === "numeric") return extractNumeric(text, q.scale ?? [1, 10]);
  return extractBinary(text, q);
}

/** Numeric encoding for scoring: numbers as-is, binary options as their index (0/1). */
export function answerValue(answer: string | number | null, q: Question): number | null {
  if (answer === null) return null;
  if (q.kind === "numeric") return typeof answer === "number" ? answer : Number(answer);
  const i = (q.options ?? []).indexOf(String(answer));
  return i >= 0 ? i : null;
}
