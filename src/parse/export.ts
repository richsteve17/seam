/**
 * Parser for claude.ai export JSON in the observed shape:
 *   { model, url, exported_at, message_count, messages: [{ role, content }] }
 *
 * Rules (all from Record 001):
 *  - strip the "Claude responded: " prefix on assistant turns
 *  - split duplicated thinking-summary fragments inlined before the real text
 *    ("Searched the webSearched the web", "Reviewing X.Reviewing X.")
 *  - flag empty assistant turns (summary only, no content) as candidate seams
 *  - preserve the raw content byte-for-byte alongside the cleaned version
 */

export interface RawExport {
  model?: string;
  url?: string;
  exported_at?: string;
  message_count?: number;
  messages: Array<{ role: string; content: string }>;
}

export interface ParsedTurn {
  index: number;               // position in the export file (never changed)
  role: "user" | "assistant";
  raw: string;                 // byte-for-byte original
  content: string;             // cleaned text
  thinking_summary: string[];  // de-duplicated inlined summaries, in order
  stripped_prefix: boolean;
  empty: boolean;              // no content after cleaning
  candidate_seam: boolean;     // empty assistant turn
  cleaning_notes: string[];
}

export interface ParsedTranscript {
  source: { model?: string; url?: string; exported_at?: string; message_count?: number; file?: string };
  turns: ParsedTurn[];
  warnings: string[];
}

export const RESPONDED_PREFIX = "Claude responded: ";

/**
 * Peel repeated leading summaries. The export inlines each thinking summary
 * twice, back to back, before the actual reply. We repeatedly take the longest
 * prefix P (4 <= |P| <= 240) such that the text starts with P+P, and remove one
 * copy from the content while recording P once.
 */
export function splitThinkingSummaries(text: string): { content: string; summaries: string[]; notes: string[] } {
  const summaries: string[] = [];
  const notes: string[] = [];
  let s = text;
  // Guard against pathological loops.
  for (let iter = 0; iter < 20; iter++) {
    const maxL = Math.min(240, Math.floor(s.length / 2));
    let found = -1;
    for (let L = maxL; L >= 4; L--) {
      if (s.startsWith(s.slice(0, L), L)) {
        // Reject trivial periodic strings ("aaaa") and chunks that are all whitespace/punctuation.
        const chunk = s.slice(0, L);
        if (!/[A-Za-z]{3,}/.test(chunk)) continue;
        // A summary is a phrase, not a paragraph: no newline inside it.
        if (chunk.includes("\n")) continue;
        found = L;
        break;
      }
    }
    if (found < 0) break;
    const chunk = s.slice(0, found);
    summaries.push(chunk.trim());
    notes.push(`split duplicated thinking summary (${found} chars): ${JSON.stringify(chunk.trim())}`);
    s = s.slice(found * 2);
    // Trailing whitespace/newline between summary and body.
    s = s.replace(/^\s+/, "");
  }
  return { content: s, summaries, notes };
}

export function cleanAssistantContent(raw: string): Omit<ParsedTurn, "index" | "role" | "raw"> {
  const notes: string[] = [];
  let s = raw;
  let stripped = false;
  if (s.startsWith(RESPONDED_PREFIX)) {
    s = s.slice(RESPONDED_PREFIX.length);
    stripped = true;
    notes.push(`stripped ${JSON.stringify(RESPONDED_PREFIX.trim())} prefix`);
  }
  const split = splitThinkingSummaries(s);
  notes.push(...split.notes);
  const content = split.content.trim();
  const empty = content.length === 0;
  if (empty) notes.push("empty assistant turn after cleaning -> candidate_seam");
  return {
    content,
    thinking_summary: split.summaries,
    stripped_prefix: stripped,
    empty,
    candidate_seam: empty,
    cleaning_notes: notes,
  };
}

export function parseExport(json: RawExport, file?: string): ParsedTranscript {
  const warnings: string[] = [];
  if (!Array.isArray(json.messages)) throw new Error("export has no messages[] array");
  if (typeof json.message_count === "number" && json.message_count !== json.messages.length) {
    warnings.push(`message_count=${json.message_count} but messages.length=${json.messages.length}`);
  }
  const turns: ParsedTurn[] = json.messages.map((m, index) => {
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
    if (!role) warnings.push(`turn ${index}: unknown role ${JSON.stringify(m.role)}; treated as user`);
    const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (role === "assistant") {
      return { index, role, raw, ...cleanAssistantContent(raw) };
    }
    const content = raw.trim();
    return {
      index,
      role: "user" as const,
      raw,
      content,
      thinking_summary: [],
      stripped_prefix: false,
      empty: content.length === 0,
      candidate_seam: false,
      cleaning_notes: [],
    };
  });
  return {
    source: { model: json.model, url: json.url, exported_at: json.exported_at, message_count: json.message_count, file },
    turns,
    warnings,
  };
}

/**
 * Parse a pasted plain-text transcript (Record 002 has no export yet). Lines
 * beginning with a speaker label start a new turn. Accepted labels (case
 * insensitive): User:, Steve:, Human:, Assistant:, Claude:, AI:. Everything
 * else continues the current turn.
 */
export function parsePastedText(text: string, file?: string): ParsedTranscript {
  const lines = text.split(/\r?\n/);
  const userRe = /^\s*(?:user|steve|human|me)\s*:\s?(.*)$/i;
  const asstRe = /^\s*(?:assistant|claude|ai|model)\s*:\s?(.*)$/i;
  const msgs: Array<{ role: string; content: string }> = [];
  let cur: { role: string; lines: string[] } | null = null;
  const flush = () => {
    if (cur) msgs.push({ role: cur.role, content: cur.lines.join("\n").trim() });
    cur = null;
  };
  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(userRe))) {
      flush();
      cur = { role: "user", lines: [m[1]] };
    } else if ((m = line.match(asstRe))) {
      flush();
      cur = { role: "assistant", lines: [m[1]] };
    } else if (cur) {
      cur.lines.push(line);
    } else if (line.trim()) {
      // Text before any label: assume the user opened.
      cur = { role: "user", lines: [line] };
    }
  }
  flush();
  const parsed = parseExport({ messages: msgs }, file);
  parsed.source.model = parsed.source.model ?? "pasted";
  return parsed;
}
