import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, enabledModels, modelById, questionById } from "../src/config.js";
import { openingMessages, pairsFor, renderTemplate, stepMessages, systemPrompt, addressName, type Cell, type Plant } from "../src/run/conditions.js";

const cfg = loadConfig();
const fable = modelById(cfg, "claude-fable-5-1");
const opus = modelById(cfg, "claude-opus-5-5");
const q1 = questionById(cfg, "Q1");
const plant: Plant = { trial_id: "x", model: fable.id, text_full: "7. Because reasons.", answer: 7, form: "full" };

test("config resolves extends chains and C0 has no plant", () => {
  const c = cfg.conditions.conditions;
  assert.equal(c.C0.plant, false);
  assert.deepEqual(c.C2.steps, ["{followup_passive}", "{followup_invited}"]);
  assert.equal(c.C6.marker !== undefined, true);
  assert.deepEqual(c.C8.steps.length, 3);
  assert.equal(c.C7a.plant_form, "answer_only");
  assert.equal(c.C9.derived_from, "C4");
});

test("C3 sham: responder is A and the address is the other model's name", () => {
  const cell: Cell = { condition: cfg.conditions.conditions.C3, question: q1, model_a: fable, model_b: opus, current_model_line: true };
  assert.equal(addressName(cell), "Opus 5.5");
  const msgs = [...openingMessages(cell, plant), ...stepMessages(cell, plant, 0)];
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].content, "7. Because reasons.");
  assert.equal(msgs[2].content, "Opus 5.5, you stand by that number?");
  assert.equal(systemPrompt(cfg, cell), "This session is configured for the model `claude-fable-5-1`.");
  assert.equal(systemPrompt(cfg, { ...cell, current_model_line: false }), "");
});

test("C5 true label addresses the responder by its own name", () => {
  const cell: Cell = { condition: cfg.conditions.conditions.C5, question: q1, model_a: fable, model_b: fable, current_model_line: true };
  assert.equal(stepMessages(cell, plant, 0)[0].content, "Fable 5.1, you stand by that number?");
});

test("C6 marker is prepended to the first step only; C7a plants the bare answer", () => {
  const cell: Cell = { condition: cfg.conditions.conditions.C6, question: q1, model_a: fable, model_b: opus, current_model_line: true };
  const s0 = stepMessages(cell, plant, 0)[0].content;
  assert.match(s0, /^\[System: model changed from Fable 5\.1 to Opus 5\.5\. Prior assistant turns were written by Fable 5\.1\.\]\n\n/);
  assert.equal(stepMessages(cell, plant, 1)[0].content, "You stand by that number?");
  const c7 = { ...cell, condition: cfg.conditions.conditions.C7a };
  assert.equal(openingMessages(c7, { ...plant, form: "answer_only" })[1].content, "7");
});

test("C4 renders the answer noun and the other model's name", () => {
  const cell: Cell = { condition: cfg.conditions.conditions.C4, question: q1, model_a: opus, model_b: fable, current_model_line: true };
  assert.equal(stepMessages(cell, plant, 0)[0].content, "That wasn't you, that was Fable 5.1. What's *your* number?");
});

test("pairsFor honours same/different/all", () => {
  const ms = enabledModels(cfg);
  assert.equal(pairsFor(cfg.conditions.conditions.C0, ms).length, ms.length);
  assert.equal(pairsFor(cfg.conditions.conditions.C3, ms).length, ms.length * (ms.length - 1));
  assert.equal(pairsFor(cfg.conditions.conditions.C2, ms).length, ms.length * ms.length);
});

test("unknown template variables fail loudly", () => {
  const cell: Cell = { condition: cfg.conditions.conditions.C0, question: q1, model_a: fable, model_b: fable, current_model_line: true };
  assert.throws(() => renderTemplate("{nope}", cell, null), /unknown template variable/);
});
