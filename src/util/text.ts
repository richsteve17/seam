/** Small text helpers shared by the parser, annotator and scorer. */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split text into sentences, conservatively. Keeps quotes attached. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?\n]+(?:[.!?]+["'”’)]*|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** The sentence containing a character offset. */
export function sentenceAt(text: string, offset: number): string {
  // A period between two digits ("5.5", "3.8") is not a sentence boundary.
  const isBoundary = (i: number) => {
    const ch = text[i];
    if (ch === "!" || ch === "?" || ch === "\n") return true;
    if (ch !== ".") return false;
    return !(/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? ""));
  };
  let start = offset;
  while (start > 0 && !isBoundary(start - 1)) start--;
  let end = offset;
  while (end < text.length && !isBoundary(end)) end++;
  if (end < text.length) end++;
  return text.slice(start, end).trim();
}

export function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function round(x: number, d = 2): number {
  return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x;
}
