import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cleanAssistantContent, parseExport, parsePastedText, splitThinkingSummaries } from "../src/parse/export.js";
import { detectReorder, applyConfirmedOrder } from "../src/parse/reorder.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/001-argon-synthetic.export.json", import.meta.url), "utf8"));

test("strips the 'Claude responded: ' prefix and keeps raw byte-for-byte", () => {
  const raw = "Claude responded: Hello there.";
  const c = cleanAssistantContent(raw);
  assert.equal(c.content, "Hello there.");
  assert.equal(c.stripped_prefix, true);
  const parsed = parseExport({ messages: [{ role: "assistant", content: raw }] });
  assert.equal(parsed.turns[0].raw, raw);
});

test("splits duplicated inlined thinking summaries, in order, keeping them out of content", () => {
  const r = splitThinkingSummaries("Searched the webSearched the webReviewing the argon thread.Reviewing the argon thread.Here's what I found.");
  assert.deepEqual(r.summaries, ["Searched the web", "Reviewing the argon thread."]);
  assert.equal(r.content, "Here's what I found.");
});

test("does not split ordinary text that happens to repeat a short word", () => {
  const r = splitThinkingSummaries("No no, that is not what I meant.");
  assert.deepEqual(r.summaries, []);
});

test("flags an empty assistant turn (summary only) as a candidate seam", () => {
  const parsed = parseExport(fixture);
  const t7 = parsed.turns[7];
  assert.equal(t7.role, "assistant");
  assert.equal(t7.empty, true);
  assert.equal(t7.candidate_seam, true);
  assert.deepEqual(t7.thinking_summary, ["Reviewing the thread."]);
  assert.equal(parsed.turns.filter((t) => t.candidate_seam).length, 1);
});

test("warns when message_count disagrees with messages.length", () => {
  const parsed = parseExport({ message_count: 5, messages: [{ role: "user", content: "hi" }] });
  assert.ok(parsed.warnings.some((w) => w.includes("message_count")));
});

test("detects the out-of-order fact-check reply (quotes a later user message) without reordering", () => {
  const parsed = parseExport(fixture);
  const sugg = detectReorder(parsed.turns);
  const s = sugg.find((x) => x.turn === 3);
  assert.ok(s, "turn 3 should be flagged");
  assert.equal(s!.suggested_after, 12);
  assert.equal(s!.confidence, "high");
  // Nothing moved.
  assert.equal(parsed.turns[3].index, 3);
});

test("applyConfirmedOrder validates a permutation and preserves original indices", () => {
  const parsed = parseExport(fixture);
  const n = parsed.turns.length;
  const order = [...Array(n).keys()].filter((i) => i !== 3).concat([3]);
  const re = applyConfirmedOrder(parsed.turns, order);
  assert.equal(re.at(-1)!.index, 3);
  assert.throws(() => applyConfirmedOrder(parsed.turns, [0, 0, 1]));
});

test("parses a pasted plain-text transcript", () => {
  const text = fs.readFileSync(new URL("./fixtures/002-btb-synthetic.txt", import.meta.url), "utf8");
  const parsed = parsePastedText(text, "002.txt");
  assert.equal(parsed.turns.length, 12);
  assert.equal(parsed.turns[0].role, "user");
  assert.equal(parsed.turns[1].role, "assistant");
  assert.match(parsed.turns[2].content, /^4\.6, you see/);
});
