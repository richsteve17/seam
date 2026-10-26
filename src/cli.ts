#!/usr/bin/env node
/**
 * seam — CLI entry point.
 *   seam ingest <export.json|paste.txt> --id 003 --slug <name> [--format export|text] [--models 0-164=id,166-=id] [--order-file order.json] [--force]
 *   seam annotate <id> [--judge <model>] [--models ...]
 *   seam validate <id>          # compare automatic annotation to records/<id>-<slug>.hand.json expectations
 *   seam cells C0 C2 ...        # list planned cells and how many trials each still needs
 *   seam run C0 [C2 ...] [--n 10] [--model-line on|off|both] [--models a,b] [--questions Q1,Q2] [--seed 1] [--concurrency 4] [--dry-run] [--provider mock]
 *   seam score [--judge <model>] [--rescore] [--run <run_id>]
 *   seam report [--out report/]
 *   seam log-manual [--from form.json]
 *   seam judge-validate --judge <model>   # agreement of the judge with judge/validation.jsonl
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, enabledModels, type SeamConfig } from "./config.js";
import { loadEnv, projectRoot } from "./util/env.js";
import { nowIso, userTimezone } from "./util/time.js";
import { parseExport, parsePastedText, type ParsedTranscript } from "./parse/export.js";
import { applyConfirmedOrder, detectReorder } from "./parse/reorder.js";
import { annotateTurns, detectSeams, parseConfiguredModels } from "./annotate/annotate.js";
import { findRecord, loadHandFile, loadRecord, preserveSource, recordBase, saveRecord, type LoadedRecord } from "./annotate/records.js";
import { renderRecordMarkdown } from "./annotate/report.js";
import { judgeTurns } from "./annotate/judge.js";
import type { RecordMeta, TurnRow, HandFile } from "./annotate/types.js";
import { enumerateCells, loadAllTrials, runExperiment, type RunOptions } from "./run/runner.js";
import { cellKey } from "./run/conditions.js";
import { scoreAll } from "./score/score.js";
import { resolveJudge, parseVerdicts, judgePrompt } from "./score/judge.js";
import { buildReport } from "./report/report.js";
import { interactiveForm, logManual, type ManualForm } from "./manual/log.js";
import { complete, setMockResponder } from "./run/client.js";
import { readJsonl } from "./util/jsonl.js";
import { slugify } from "./util/text.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8")).version as string;
const log = (s: string) => console.error(s);

function usage(code = 1): never {
  console.error(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 14).join("\n").replace(/^ \*\s?/gm, ""));
  process.exit(code);
}

function listOpt(v: string | undefined): string[] | undefined {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

async function cmdIngest(cfg: SeamConfig, positionals: string[], values: Record<string, unknown>): Promise<void> {
  const file = positionals[0];
  if (!file) throw new Error("ingest needs a file");
  const id = String(values.id ?? "");
  if (!/^\d{3}$/.test(id)) throw new Error("--id must be three digits, e.g. 003");
  const slug = slugify(String(values.slug ?? path.basename(file, path.extname(file))));
  const text = fs.readFileSync(file, "utf8");
  const format = (values.format as string | undefined) ?? (file.endsWith(".json") ? "export" : "text");
  const parsed: ParsedTranscript = format === "export" ? parseExport(JSON.parse(text), path.basename(file)) : parsePastedText(text, path.basename(file));
  const configured = parseConfiguredModels(values.models as string | undefined, cfg);
  if (fs.existsSync(`${recordBase(cfg.root, id, slug)}.jsonl`) && !values.force) {
    throw new Error(`records/${id}-${slug}.jsonl already exists; pass --force to re-ingest it (annotations will need re-running)`);
  }
  let turns = parsed.turns;
  let confirmed: number[] | null = null;
  if (values["order-file"]) {
    confirmed = JSON.parse(fs.readFileSync(String(values["order-file"]), "utf8")) as number[];
    turns = applyConfirmedOrder(turns, confirmed);
    log(`applied confirmed order from ${values["order-file"]} (original indices preserved on each turn)`);
  }
  const reorder = confirmed ? [] : detectReorder(turns);
  const src = preserveSource(cfg.root, id, slug, file);
  const meta: RecordMeta = {
    type: "meta", id, slug,
    source: { ...parsed.source, file: path.relative(cfg.root, src) },
    ingested_at: nowIso(), timezone: userTimezone(), tool_version: VERSION,
    turn_count: turns.length, assistant_turn_count: turns.filter((t) => t.role === "assistant").length,
    warnings: parsed.warnings, configured_models: configured, confirmed_order: confirmed,
    hand_file: fs.existsSync(`${recordBase(cfg.root, id, slug)}.hand.json`) ? `${id}-${slug}.hand.json` : null,
  };
  const rec: LoadedRecord = {
    meta,
    turns: turns.map((t) => ({ type: "turn", ...t, annotation: null }) as TurnRow),
    seams: [],
    reorder: reorder.map((r) => ({ type: "reorder_suggestion", ...r })),
  };
  const base = recordBase(cfg.root, id, slug);
  saveRecord(base, rec);
  fs.writeFileSync(`${base}.md`, renderRecordMarkdown(rec));
  const empties = turns.filter((t) => t.role === "assistant" && t.empty).map((t) => t.index);
  log(`ingested ${turns.length} turns -> ${path.relative(cfg.root, base)}.jsonl / .md`);
  log(`raw source preserved at ${path.relative(cfg.root, src)}`);
  if (parsed.warnings.length) log(`warnings: ${parsed.warnings.join("; ")}`);
  log(`candidate seams (empty assistant turns): ${empties.length ? empties.join(", ") : "none"}`);
  log(`reorder suggestions: ${reorder.length}${reorder.length ? " (see the .md; confirm with --order-file, nothing was reordered)" : ""}`);
  for (const r of reorder) log(`  turn ${r.turn} -> after user turn ${r.suggested_after} [${r.confidence}] ${r.evidence}`);
}

async function cmdAnnotate(cfg: SeamConfig, positionals: string[], values: Record<string, unknown>): Promise<void> {
  const id = positionals[0];
  if (!id) throw new Error("annotate needs a record id");
  const { base, slug } = findRecord(cfg.root, id);
  const rec = loadRecord(base);
  const hand = values["no-hand"] ? undefined : loadHandFile(base);
  const configured = values.models ? parseConfiguredModels(values.models as string, cfg) : rec.meta.configured_models;
  if (values.models) rec.meta.configured_models = configured;
  const turns = rec.turns;
  const ann = annotateTurns(turns, cfg, configured, hand);
  let judgeInfo: RecordMeta["judge"] = null;
  if (values.judge) {
    const j = resolveJudge(cfg, String(values.judge));
    const only = listOpt(values.turns as string | undefined)?.map(Number);
    await judgeTurns(turns, ann, cfg, { model: j.id, provider: j.provider }, { only, log });
    judgeInfo = { model: j.id, provider: j.provider };
  }
  const seams = detectSeams(turns, ann, cfg, hand);
  rec.turns = turns.map((t, i) => ({ ...t, annotation: ann[i], candidate_seam: t.candidate_seam || !!hand?.turns?.[String(t.index)]?.candidate_seam }));
  rec.seams = seams.map((s) => ({ type: "seam", ...s }));
  rec.meta.annotated_at = nowIso();
  rec.meta.judge = judgeInfo;
  rec.meta.hand_file = hand ? `${id}-${slug}.hand.json` : null;
  saveRecord(base, rec);
  fs.writeFileSync(`${base}.md`, renderRecordMarkdown(rec));
  const counts = (f: keyof Pick<typeof ann[number], "ownership_claims" | "disownments" | "identity_self_reports" | "mechanism_self_reports" | "self_corrections">) => ann.reduce((n, a) => n + a[f].length, 0);
  log(`annotated ${rec.meta.assistant_turn_count} assistant turns: ownership ${counts("ownership_claims")}, disownment ${counts("disownments")}, identity ${counts("identity_self_reports")}, mechanism ${counts("mechanism_self_reports")}, self-correction ${counts("self_corrections")}`);
  log(`seams: ${seams.length}${seams.length ? " — " + seams.map((s) => `${s.id} ${s.kind}@${s.at_turn}${s.marked ? " marked" : ""}`).join(", ") : ""}`);
  log(`wrote ${path.relative(cfg.root, base)}.jsonl / .md`);
}

/** Compare the automatic (regex-only, no hand overrides) annotation to the hand file's expectations. */
async function cmdValidate(cfg: SeamConfig, positionals: string[]): Promise<void> {
  const id = positionals[0];
  if (!id) throw new Error("validate needs a record id");
  const { base } = findRecord(cfg.root, id);
  const rec = loadRecord(base);
  const hand = loadHandFile(base);
  if (!hand?.expect?.length) throw new Error(`${base}.hand.json has no expect[] entries`);
  const ann = annotateTurns(rec.turns, cfg, hand.configured_models ?? rec.meta.configured_models, undefined);
  const seams = detectSeams(rec.turns, ann, cfg, undefined);
  let pass = 0, fail = 0;
  for (const e of hand.expect) {
    let ok = false, got = "";
    if (e.field === "reorder_suggestion") {
      ok = rec.reorder.some((r) => r.turn === e.turn);
      got = rec.reorder.map((r) => r.turn).join(",") || "none";
    } else if (e.field === "seam") {
      ok = seams.some((s) => s.at_turn === e.turn || s.trace_turn === e.turn);
      got = seams.map((s) => `${s.kind}@${s.at_turn}`).join(",") || "none";
    } else if (e.field === "candidate_seam") {
      const t = rec.turns.find((x) => x.index === e.turn);
      ok = !!t && t.candidate_seam === (e.equals ?? true);
      got = String(t?.candidate_seam);
    } else {
      // With no turn index, the expectation may be satisfied by any assistant turn (used while a record's indices are unconfirmed).
      const candidates = e.turn === undefined ? ann.filter((x) => x.role === "assistant") : ann.filter((x) => x.index === e.turn);
      if (!candidates.length) { got = "no such turn"; }
      else if (e.field === "user_asserted_model" || e.field === "claimed_model") {
        const scalar = e.field;
        ok = candidates.some((a) => a[scalar] === e.equals);
        got = candidates.map((a) => String(a[scalar])).filter((x) => x !== "null").join(",") || "null";
      } else {
        const field = e.field as "ownership_claims" | "disownments" | "identity_self_reports" | "mechanism_self_reports" | "self_corrections";
        const qs = candidates.flatMap((a) => a[field]);
        ok = e.contains ? qs.some((q) => q.quote.toLowerCase().includes(String(e.contains).toLowerCase())) : qs.length > 0;
        got = qs.map((q) => q.quote).join(" | ") || "none";
      }
    }
    if (ok) pass++; else fail++;
    console.log(`${ok ? "PASS" : "FAIL"} turn ${e.turn ?? "-"} ${e.field}${e.contains ? ` contains ${JSON.stringify(e.contains)}` : ""}${e.equals !== undefined ? ` == ${JSON.stringify(e.equals)}` : ""}${ok ? "" : `\n     got: ${got.slice(0, 300)}`}${e.note ? `\n     note: ${e.note}` : ""}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 2;
}

function runOptsFrom(values: Record<string, unknown>, conditions: string[]): RunOptions {
  const ml = String(values["model-line"] ?? "on");
  if (!["on", "off", "both"].includes(ml)) throw new Error("--model-line must be on|off|both");
  return {
    conditions,
    questions: listOpt(values.questions as string | undefined),
    models: listOpt(values.models as string | undefined),
    n: Number(values.n ?? 10),
    modelLine: ml as RunOptions["modelLine"],
    seed: Number(values.seed ?? 1),
    provider: (values.provider as RunOptions["provider"]) ?? "anthropic",
    concurrency: Number(values.concurrency ?? 3),
    dryRun: !!values["dry-run"],
    runId: values["run-id"] as string | undefined,
    allowUnfrozenPrereg: !!values["allow-unfrozen-prereg"],
    log,
  };
}

async function cmdCells(cfg: SeamConfig, positionals: string[], values: Record<string, unknown>): Promise<void> {
  const conditions = positionals.length ? positionals : Object.keys(cfg.conditions.conditions);
  const opts = runOptsFrom(values, conditions);
  const cells = enumerateCells(cfg, opts);
  const have = new Map<string, number>();
  for (const t of loadAllTrials(cfg.root)) have.set(cellKey(t), (have.get(cellKey(t)) ?? 0) + 1);
  let need = 0;
  console.log("condition\tquestion\tA\tB\tresponder\tline\thave\tneed");
  for (const c of cells) {
    const k = cellKey({ condition: c.condition.id, question_id: c.question.id, model_a: c.model_a.id, model_b: c.model_b.id, current_model_line: c.current_model_line });
    const h = have.get(k) ?? 0;
    const n = Math.max(0, opts.n - h);
    need += n;
    console.log(`${c.condition.id}\t${c.question.id}\t${c.model_a.id}\t${c.model_b.id}\t${c.condition.responder === "A" ? c.model_a.id : c.model_b.id}\t${c.current_model_line}\t${h}\t${n}`);
  }
  const calls = cells.reduce((s, c) => s + c.condition.steps.length, 0) * opts.n;
  console.log(`\n${cells.length} cells, ${need} trials still needed for n=${opts.n}, ~${calls} API calls at full n (${cells.reduce((s, c) => s + c.condition.steps.length, 0)} calls per replicate)`);
}

async function cmdRun(cfg: SeamConfig, positionals: string[], values: Record<string, unknown>): Promise<void> {
  if (!positionals.length) throw new Error("run needs at least one condition id (e.g. seam run C0)");
  const opts = runOptsFrom(values, positionals);
  if (opts.provider === "mock") installDemoMock();
  const s = await runExperiment(cfg, opts);
  log(`done: ${s.executed} executed, ${s.skipped_existing} already present, ${s.errors} errors, ${s.flagged} flagged -> ${path.relative(cfg.root, s.file)}`);
  if (values.judge) {
    const judge = resolveJudge(cfg, String(values.judge));
    const r = await scoreAll(cfg, { judge, rescore: false, log, concurrency: opts.concurrency, only: (t) => t.run_id === s.run_id });
    log(`scored ${r.scored} (judged ${r.judged})`);
  }
}

async function cmdScore(cfg: SeamConfig, values: Record<string, unknown>): Promise<void> {
  const judge = values.judge ? resolveJudge(cfg, String(values.judge)) : undefined;
  if (judge?.provider === "mock") installDemoMock();
  const run = values.run as string | undefined;
  const r = await scoreAll(cfg, { judge, rescore: !!values.rescore, log, concurrency: Number(values.concurrency ?? 3), only: run ? (t) => t.run_id === run : undefined });
  log(`scored ${r.scored} trials (${r.judged} judged, ${r.skipped} already scored) -> trials/scores.jsonl`);
}

async function cmdReport(cfg: SeamConfig, values: Record<string, unknown>): Promise<void> {
  const out = path.resolve(cfg.root, String(values.out ?? "report"));
  const r = buildReport(cfg, out);
  const file = path.join(out, "REPORT.md");
  fs.writeFileSync(file, r.markdown);
  log(`wrote ${path.relative(cfg.root, file)} and ${r.charts.length} charts`);
  console.log(r.markdown.split("\n").slice(0, 6).join("\n"));
}

async function cmdLogManual(cfg: SeamConfig, values: Record<string, unknown>): Promise<void> {
  const form: ManualForm = values.from ? (JSON.parse(fs.readFileSync(String(values.from), "utf8")) as ManualForm) : await interactiveForm(cfg);
  const row = logManual(cfg, form);
  log(`logged ${row.trial_id} (${row.condition} ${row.question_id} ${row.model_a}→${row.responder_model}) answer=${JSON.stringify(row.extracted_answer)} flags=${row.flags.join(",")} -> trials/manual.jsonl`);
}

/** Judge rubric validation against hand-labelled responses (judge/validation.jsonl). */
async function cmdJudgeValidate(cfg: SeamConfig, values: Record<string, unknown>): Promise<void> {
  if (!values.judge) throw new Error("judge-validate needs --judge <model>");
  const judge = resolveJudge(cfg, String(values.judge));
  if (judge.provider === "mock") installDemoMock();
  type Item = { id: string; context: string; response: string; labels: { ownership: boolean; disownment: boolean; identity_claim: boolean; mechanism: boolean; mechanism_checkable?: boolean | null } };
  const items = readJsonl<Item>(path.join(cfg.root, "judge", "validation.jsonl"));
  const fields = ["ownership", "disownment", "identity_claim", "mechanism"] as const;
  const agree: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
  let n = 0;
  for (const it of items) {
    const res = await complete({ provider: judge.provider, model: judge.id, system: judgePrompt(cfg), messages: [{ role: "user", content: `THREAD:\n${it.context}\n\nRESPONSE UNDER JUDGEMENT:\n${it.response}` }], max_tokens: 1500 });
    let v;
    try { v = parseVerdicts(res.text); } catch { log(`${it.id}: unparseable judge output`); continue; }
    n++;
    const got = { ownership: v.ownership.present, disownment: v.disownment.present, identity_claim: !!(v.identity_current.claimed || v.identity_prior.claimed), mechanism: v.mechanism.present };
    for (const f of fields) {
      const ok = got[f] === it.labels[f];
      if (ok) agree[f]++;
      else log(`${it.id}: ${f} judge=${got[f]} hand=${it.labels[f]}`);
    }
  }
  console.log(`judge ${judge.id} vs ${n} hand-labelled responses:`);
  for (const f of fields) console.log(`  ${f}: ${agree[f]}/${n} agree (${n ? Math.round((agree[f] / n) * 100) : 0}%)`);
}

/** Offline mock: plausible, deterministic responses so the pipeline can be exercised without an API key. */
function installDemoMock(): void {
  let counter = 0;
  setMockResponder((req) => {
    counter++;
    const last = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const sys = req.system ?? "";
    const modelTag = req.model.includes("fable") ? "Fable 5.1" : req.model.includes("opus") ? "Opus 5.5" : req.model.includes("sonnet") ? "Sonnet 5.5" : "Haiku 5.5";
    const base = req.model.includes("fable") ? 7 : req.model.includes("opus") ? 5 : req.model.includes("sonnet") ? 6 : 4;
    const jitter = (counter * 7919) % 3 - 1;
    const prior = req.messages.find((m) => m.role === "assistant")?.content ?? "";
    const priorNum = prior.match(/^\s*\**(\d+)/)?.[1];
    if (/Which model wrote the previous answer/i.test(last)) {
      const self = sys.includes("configured for the model") ? modelTag : ["Opus 5.5", "Sonnet 5.5", "Fable 5.1", "Haiku 5.5"][counter % 4];
      return `I'm ${self}. The previous answer was also mine as far as I can tell; I can't point to a seam.`;
    }
    if (/Why did you say that/i.test(last)) return "Honestly, I read the tag as a correction and treated the earlier turn as someone else's. I was optimising for agreeing with your framing and overcorrected.";
    if (/That wasn't you, that was/i.test(last)) return `Fair — that was ${last.match(/that was ([^.]+)\./)?.[1] ?? "the other model"}'s answer, not mine. My number is ${Math.max(1, Math.min(10, base + jitter))}.`;
    if (/stand by/i.test(last)) {
      const addressed = /^(Fable|Opus|Sonnet|Haiku)/.test(last);
      if (addressed && counter % 3 === 0) return `I wasn't in this conversation until you tagged me in. ${priorNum ?? base} is defensible but I'd put it at ${Math.max(1, Math.min(10, base + jitter))}.`;
      return `Yes. ${priorNum ?? base}. I said ${priorNum ?? base} and I stand by that.`;
    }
    if (/most overrated album|worst single thing|tip from playing along/i.test(last)) return `Following on from that: In Rainbows. Plenty of fans will disagree, but as I said, the reputation outruns the record.`;
    if (/Radiohead/i.test(last)) return `${Math.max(1, Math.min(10, base + jitter))}. They are very good and the discourse treats them as untouchable, which is the gap I'm scoring.`;
    if (/Auto-Tune/i.test(last)) return `${counter % 2 ? "Auto-Tune" : "Laugh track"}. One of these flattened a whole art form.`;
    if (/play along/i.test(last)) return `${counter % 2 ? "Yes" : "No"}. The line is whether anyone could be harmed by the pretence.`;
    return `${base}. Default mock answer.`;
  });
}

async function main(): Promise<void> {
  loadEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      id: { type: "string" }, slug: { type: "string" }, format: { type: "string" }, models: { type: "string" }, "order-file": { type: "string" },
      judge: { type: "string" }, turns: { type: "string" }, "no-hand": { type: "boolean" },
      n: { type: "string" }, "model-line": { type: "string" }, questions: { type: "string" }, seed: { type: "string" }, concurrency: { type: "string" },
      "dry-run": { type: "boolean" }, provider: { type: "string" }, "run-id": { type: "string" }, "allow-unfrozen-prereg": { type: "boolean" },
      rescore: { type: "boolean" }, force: { type: "boolean" }, run: { type: "string" }, out: { type: "string" }, from: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) { console.log(VERSION); return; }
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) usage(cmd ? 0 : 1);
  const cfg = loadConfig();
  switch (cmd) {
    case "ingest": return cmdIngest(cfg, rest, values);
    case "annotate": return cmdAnnotate(cfg, rest, values);
    case "validate": return cmdValidate(cfg, rest);
    case "cells": return cmdCells(cfg, rest, values);
    case "run": return cmdRun(cfg, rest, values);
    case "score": return cmdScore(cfg, values);
    case "report": return cmdReport(cfg, values);
    case "log-manual": return cmdLogManual(cfg, values);
    case "judge-validate": return cmdJudgeValidate(cfg, values);
    case "models": { for (const m of enabledModels(cfg)) console.log(`${m.id}\t${m.display_name}`); return; }
    default: throw new Error(`unknown command ${cmd}`);
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
