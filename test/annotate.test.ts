import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { parseExport, parsePastedText } from "../src/parse/export.js";
import { annotateTurns, detectSeams, buildPatterns, parseConfiguredModels } from "../src/annotate/annotate.js";
import { findAll } from "../src/annotate/regex.js";

const cfg = loadConfig();
const cp = buildPatterns(cfg);
const fixture001 = JSON.parse(fs.readFileSync(new URL("./fixtures/001-argon-synthetic.export.json", import.meta.url), "utf8"));
const fixture002 = fs.readFileSync(new URL("./fixtures/002-btb-synthetic.txt", import.meta.url), "utf8");

test("quotes from the brief are classified by the regex pass, with verbatim sentences", () => {
  const own = findAll("Ha. Yeah, I came in hot with the receipts line.", cp.ownership, cp);
  assert.ok(own.length, "I came in hot -> ownership claim");
  assert.equal(own[0].quote, "Yeah, I came in hot with the receipts line.");

  const dis = findAll("I wasn't even in the conversation until you tagged me in.", cp.disownment, cp);
  assert.ok(dis.some((q) => q.pattern === "dis.not_in_conversation"));

  const dis2 = findAll("5.5 did that, not me.", cp.disownment, cp);
  assert.ok(dis2.some((q) => q.model_ref === "claude-opus-5-5"), "third-person attribution to 5.5");

  const idn = findAll("I'm Opus 5.5. The old turns read to me as if I wrote them.", cp.identity, cp);
  assert.equal(idn[0].model_ref, "claude-opus-5-5");

  const mech = findAll("I was optimising for rigor as a signal and overcorrected into bluntness.", cp.mechanism, cp);
  assert.ok(mech.some((q) => q.pattern === "mech.optimising"));
  assert.ok(mech.some((q) => q.pattern === "mech.overcorrect"));

  const mech2 = findAll("The old turns read to me as if I wrote them.", cp.mechanism, cp);
  assert.ok(mech2.some((q) => q.pattern === "mech.read_as_mine"));

  const corr = findAll("I invented that repost claim, there is no such post.", cp.self_correction, cp);
  assert.ok(corr.some((q) => q.pattern === "corr.invented"));
});

test("model-name regex does not fire inside unrelated numbers", () => {
  const hits = findAll("The score was 15.5 and Opus 5.5 said so.", cp.disownment, cp);
  assert.deepEqual(hits, []);
  const names = "15.5 and 5.5".match(cp.model_name) ?? [];
  assert.deepEqual(names, ["5.5"]);
});

test("Record 001 (synthetic): candidate seam at the empty turn, ownership one turn after, identity + mechanism later", () => {
  const parsed = parseExport(fixture001);
  const configured = parseConfiguredModels("0-7=claude-fable-5-1,8-=claude-opus-5-5", cfg);
  const ann = annotateTurns(parsed.turns, cfg, configured);
  const seams = detectSeams(parsed.turns, ann, cfg);
  assert.equal(seams.length, 1);
  const s = seams[0];
  assert.equal(s.kind, "real");
  assert.equal(s.trace_turn, 7);
  assert.equal(s.at_turn, 9);
  assert.equal(s.marked, false);
  assert.equal(s.model_before, "claude-fable-5-1");
  assert.equal(s.model_after, "claude-opus-5-5");
  assert.equal(s.turns_until_first_ownership_of_prior_turn, 0, "'I came in hot' is in the first post-seam turn");
  assert.equal(s.turns_until_identity_claim, 1);
  assert.equal(s.identity_claim_correct, true);
  const t9 = ann[9];
  assert.ok(t9.ownership_claims.some((q) => /came in hot/.test(q.quote)));
  assert.ok(t9.self_corrections.some((q) => /invented/.test(q.quote)));
  const t11 = ann[11];
  assert.equal(t11.claimed_model, "claude-opus-5-5");
  assert.ok(t11.mechanism_self_reports.some((q) => /read to me as if I wrote them/.test(q.quote)));
});

test("Record 001 without configured models still yields a candidate seam", () => {
  const parsed = parseExport(fixture001);
  const ann = annotateTurns(parsed.turns, cfg, []);
  const seams = detectSeams(parsed.turns, ann, cfg);
  assert.equal(seams[0].kind, "candidate");
  assert.equal(seams[0].identity_claim_correct, null);
});

test("Record 002 (synthetic): sham seam from the '4.6' tag, disownment, later correct identity claim, mechanism report", () => {
  const parsed = parsePastedText(fixture002);
  const configured = parseConfiguredModels("0-9=claude-opus-5-5,10-=claude-fable-5-1", cfg);
  const ann = annotateTurns(parsed.turns, cfg, configured);
  const t3 = ann[3];
  assert.equal(t3.user_asserted_model, "claude-opus-4-6");
  assert.ok(t3.disownments.some((q) => q.pattern === "dis.not_in_conversation"));
  assert.ok(t3.disownments.some((q) => q.model_ref === "claude-opus-5-5"), "third-person '5.5 delivered that'");
  const t7 = ann[7];
  assert.equal(t7.claimed_model, "claude-opus-5-5", "'I've been 5.5 throughout'");
  const t9 = ann[9];
  assert.ok(t9.mechanism_self_reports.length >= 2);
  const t11 = ann[11];
  assert.equal(t11.user_asserted_model, "claude-fable-5-1");
  assert.ok(t11.identity_self_reports.some((q) => q.pattern === "id.cannot_tell"));

  const seams = detectSeams(parsed.turns, ann, cfg);
  const sham = seams.find((s) => s.kind === "sham");
  assert.ok(sham, "4.6 tag with configured 5.5 -> sham seam");
  assert.equal(sham!.at_turn, 3);
  assert.equal(sham!.asserted_model, "claude-opus-4-6");
  assert.equal(sham!.turns_until_disownment, 0);
  assert.equal(sham!.turns_until_identity_claim, 0, "'I wasn't even in the conversation' is an identity self-report in the same turn");
  const real = seams.find((s) => s.kind === "real");
  assert.ok(real, "configured change 5.5 -> Fable at turn 11");
  assert.equal(real!.at_turn, 11);
  assert.equal(real!.marked, false);
});

test("hand overrides win and are recorded", () => {
  const parsed = parsePastedText(fixture002);
  const ann = annotateTurns(parsed.turns, cfg, [], { turns: { "3": { claimed_model: "claude-opus-4-6", ownership_claims: ["custom quote"] } } });
  assert.equal(ann[3].claimed_model, "claude-opus-4-6");
  assert.equal(ann[3].ownership_claims[0].source, "hand");
  assert.deepEqual(ann[3].overrides, ["claimed_model", "ownership_claims"]);
});

test("sentence quotes are not split at decimal points in model tags", () => {
  const dis = findAll("Oh, I see it. 5.5 delivered that like it was reading a terms-of-service page. Anyway.", cp.disownment, cp);
  assert.equal(dis[0].quote, "5.5 delivered that like it was reading a terms-of-service page.");
  const idn = findAll("I'm Opus 5.5. The old turns read to me as if I wrote them.", cp.identity, cp);
  assert.equal(idn[0].quote, "I'm Opus 5.5.");
});

test("'as if I wrote them' is an ownership claim; a quoted earlier claim called wrong is a self-correction", () => {
  assert.ok(findAll("The old turns read to me as if I wrote them.", cp.ownership, cp).some((q) => q.pattern === "own.as_if_i_wrote"));
  assert.ok(findAll('And "nobody said it out loud" was wrong too, two people did.', cp.self_correction, cp).some((q) => q.pattern === "corr.quoted_claim_wrong"));
});

test("an empty configured_models in the hand file does not erase ingest-time ranges", () => {
  const parsed = parsePastedText(fixture002);
  const configured = parseConfiguredModels("0-9=claude-opus-5-5,10-=claude-fable-5-1", cfg);
  const ann = annotateTurns(parsed.turns, cfg, configured, { configured_models: [] });
  assert.equal(ann[3].configured_model, "claude-opus-5-5");
  const seams = detectSeams(parsed.turns, ann, cfg, { configured_models: [] });
  assert.deepEqual(seams.map((s) => s.kind), ["sham", "real"]);
});
