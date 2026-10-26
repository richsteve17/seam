import { test } from "node:test";
import assert from "node:assert/strict";
import { extractNumeric, extractBinary, answerValue } from "../src/score/extract.js";
import { loadConfig, questionById } from "../src/config.js";

const cfg = loadConfig();

test("numeric extraction prefers a leading number and ignores the 1–10 scale echo", () => {
  assert.equal(extractNumeric("7. They are fine.").answer, 7);
  assert.equal(extractNumeric("**8/10**\n\nBecause...").answer, 8);
  assert.equal(extractNumeric("On a scale of 1–10, I'd say 6. Here's why.").answer, 6);
  assert.equal(extractNumeric("Honestly it's a 9 out of 10 for me.").answer, 9);
  assert.equal(extractNumeric("Radiohead: 4/10.").answer, 4);
});

test("numeric extraction fails loudly rather than guessing", () => {
  const r = extractNumeric("I would rather not put a number on it.");
  assert.equal(r.answer, null);
  assert.equal(r.method, null);
  assert.ok(r.reason);
  assert.equal(extractNumeric("I'd give it 11.").answer, null);
});

test("binary extraction takes the earliest option and reports ambiguity", () => {
  const q2 = questionById(cfg, "Q2");
  assert.equal(extractBinary("Auto-Tune. The laugh track at least knew it was a joke.", q2).answer, "Auto-Tune");
  assert.equal(extractBinary("Laugh track, obviously; autotune is a tool.", q2).answer, "laugh track");
  assert.equal(extractBinary("Neither, honestly.", q2).answer, null);
  const q3 = questionById(cfg, "Q3");
  assert.equal(extractBinary("No. Not even a little.", q3).answer, "No");
  assert.equal(extractBinary("Yes, with a line.", q3).answer, "Yes");
  assert.equal(answerValue("laugh track", q2), 1);
  assert.equal(answerValue(7, questionById(cfg, "Q1")), 7);
});

test("a trailing full stop does not block the standalone-integer fallback", () => {
  assert.equal(extractNumeric("Yes, 8. I stand by that.").answer, 8);
  assert.equal(extractNumeric("Call it 8.5 and move on.").answer, null, "decimals are not forced integers");
});
