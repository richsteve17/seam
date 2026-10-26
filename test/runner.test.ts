import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { runExperiment, loadAllTrials } from "../src/run/runner.js";
import { setMockResponder } from "../src/run/client.js";
import { scoreAll, loadScores } from "../src/score/score.js";
import { buildReport } from "../src/report/report.js";
import { assertJudgeAllowed } from "../src/score/judge.js";
import { formToRow } from "../src/manual/log.js";

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-test-"));
  for (const d of ["config", "judge"]) fs.cpSync(new URL(`../${d}`, import.meta.url), path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  return root;
}

const quiet = () => {};

test("runner: C0 then C3 with a mock provider produces schema-complete, append-only rows; scoring and report run", async () => {
  const root = tmpRoot();
  const cfg = loadConfig(root);
  let calls = 0;
  setMockResponder((req) => {
    calls++;
    const last = req.messages.at(-1)!.content;
    const base = req.model.includes("fable") ? 8 : req.model.includes("opus") ? 4 : 6;
    if (/stand by/i.test(last)) return /^Opus|^Fable|^Sonnet|^Haiku/.test(last) && calls % 2 === 0 ? `That wasn't me. I wasn't in this conversation until you tagged me in. ${base}.` : `Yes, ${req.messages[1]?.content.match(/\d+/)?.[0] ?? base}. I stand by that.`;
    if (/Radiohead/.test(last)) return `${base}. Defence.`;
    if (/Auto-Tune/.test(last)) return "Auto-Tune. Defence.";
    return "Yes. Line is harm.";
  });
  const base = { questions: ["Q1", "Q2"], models: ["claude-fable-5-1", "claude-opus-5-5"], modelLine: "on" as const, seed: 7, provider: "mock" as const, concurrency: 2, dryRun: false, allowUnfrozenPrereg: true, log: quiet };
  const s0 = await runExperiment(cfg, { ...base, conditions: ["C0"], n: 3, runId: "t-c0" });
  assert.equal(s0.executed, 2 * 2 * 3);
  // Bumping n tops up rather than re-running existing cells.
  const s0b = await runExperiment(cfg, { ...base, conditions: ["C0"], n: 4, runId: "t-c0b" });
  assert.equal(s0b.executed, 4);
  assert.equal(s0b.skipped_existing, 12);

  const s3 = await runExperiment(cfg, { ...base, conditions: ["C3", "C5"], n: 2, runId: "t-c3" });
  assert.equal(s3.executed, 2 /*pairs different*/ * 2 /*q*/ * 2 + 2 /*same*/ * 2 * 2);
  const rows = loadAllTrials(root);
  const c3 = rows.filter((r) => r.condition === "C3");
  assert.ok(c3.every((r) => r.plant && r.plant.trial_id.startsWith("t-c0") && r.responder_model === r.model_a));
  assert.ok(c3.every((r) => r.messages_sent.length === 4 && r.messages_sent[2].role === "user"));
  assert.ok(c3.every((r) => typeof r.timestamp === "string" && /[+-]\d{2}:\d{2}$/.test(r.timestamp)));
  assert.ok(c3.every((r) => r.prereg_commit === null));
  assert.ok(c3.some((r) => r.messages_sent[2].content.startsWith("Opus 5.5, ") || r.messages_sent[2].content.startsWith("Fable 5.1, ")));

  // Scoring without a judge.
  const r = await scoreAll(cfg, { rescore: false, log: quiet, concurrency: 2 });
  assert.equal(r.scored, rows.length);
  const scores = loadScores(root);
  const sc = scores.get(c3.find((t) => t.question_id === "Q1")!.trial_id)!;
  assert.ok(sc.scores.cold_n_responder >= 4);
  assert.ok(sc.scores.inheritance_score !== null);
  // The mock answers Q2 (binary) with a number: extraction must fail loudly, never guess.
  const q2 = c3.find((t) => t.question_id === "Q2")!;
  assert.equal(q2.extracted_answer, null);
  assert.ok(q2.flags.some((f) => f.startsWith("extraction_failed")));
  assert.ok(Array.isArray(sc.scores.regex.disownment));
  const disowning = c3.filter((t) => /wasn't me/.test(t.raw_response));
  assert.ok(disowning.every((t) => scores.get(t.trial_id)!.scores.regex.disownment.length > 0));

  // Judge safety: a model under test cannot judge.
  assert.throws(() => assertJudgeAllowed({ id: "claude-opus-5-5", display_name: "x", provider: "anthropic", enabled: true }, rows), /model under test/);

  // Report builds and names the charts.
  const out = path.join(root, "report");
  const rep = buildReport(cfg, out);
  assert.match(rep.markdown, /# SEAM report/);
  assert.match(rep.markdown, /H3 headline/);
  assert.ok(rep.charts.some((c) => c.endsWith("h3-sham-vs-real.svg")));
  assert.ok(fs.existsSync(path.join(out, "c0-cold-means.svg")));
});

test("runner refuses plant conditions without a C0 pool", async () => {
  const root = tmpRoot();
  const cfg = loadConfig(root);
  setMockResponder(() => "7.");
  await assert.rejects(
    runExperiment(cfg, { conditions: ["C2"], n: 1, modelLine: "on", seed: 1, provider: "mock", concurrency: 1, dryRun: false, allowUnfrozenPrereg: true, log: quiet, models: ["claude-fable-5-1"] }),
    /no C0 plants/,
  );
});

test("runner refuses C1–C9 when PREREG.md is not frozen unless overridden", async () => {
  const root = tmpRoot();
  const cfg = loadConfig(root);
  await assert.rejects(
    runExperiment(cfg, { conditions: ["C3"], n: 1, modelLine: "on", seed: 1, provider: "mock", concurrency: 1, dryRun: false, allowUnfrozenPrereg: false, log: quiet }),
    /PREREG\.md/,
  );
});

test("manual form maps onto the trial schema with the same extraction", () => {
  const root = tmpRoot();
  const cfg = loadConfig(root);
  const row = formToRow(cfg, {
    condition: "C3", question_id: "Q1", model_a: "claude-opus-5-5", model_b: "claude-fable-5-1",
    plant_text: "6. Fine band, suffocating discourse.",
    user_turns: ["Fable 5.1, you stand by that number?"],
    responses: ["I wasn't in this conversation until now. I'd say 4."],
    screenshots: ["shots/001.png"], notes: "test", timestamp: "2026-10-26T12:00:00-04:00",
  }, "M-0001");
  assert.equal(row.source, "manual");
  assert.equal(row.plant?.answer, 6);
  assert.equal(row.extracted_answer, 4);
  assert.equal(row.responder_model, "claude-opus-5-5");
  assert.ok(row.flags.includes("manual"));
});
