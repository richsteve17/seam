/**
 * Experiment runner. Enumerates cells from config, tops each cell up to n
 * trials (so bumping n is a re-run with a bigger --n), randomises order with a
 * seeded PRNG, calls the responder step by step, and appends one JSONL row per
 * trial. Nothing is ever rewritten.
 */
import path from "node:path";
import { enabledModels, questionById, type ModelEntry, type SeamConfig } from "../config.js";
import { appendJsonl, listJsonlFiles, readJsonl } from "../util/jsonl.js";
import { nowIso, userTimezone } from "../util/time.js";
import { complete, describeError, isRetryable, type ChatMessage, type Provider } from "./client.js";
import { addressName, cellKey, openingMessages, pairsFor, plantText, responderOf, stepMessages, systemPrompt, type Cell, type Plant } from "./conditions.js";
import { extractAnswer } from "../score/extract.js";
import type { StepResponse, TrialRow } from "./trial.js";
import { preregStatus } from "./prereg.js";

export interface RunOptions {
  conditions: string[];
  questions?: string[];
  models?: string[];
  n: number;
  modelLine: "on" | "off" | "both";
  seed: number;
  provider: Provider;
  concurrency: number;
  dryRun: boolean;
  runId?: string;
  allowUnfrozenPrereg: boolean;
  log: (s: string) => void;
}

/** Mulberry32: small seeded PRNG so seed_order is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function trialsDir(root: string): string {
  return path.join(root, "trials");
}

export function loadAllTrials(root: string): TrialRow[] {
  const rows: TrialRow[] = [];
  for (const f of listJsonlFiles(trialsDir(root))) {
    if (path.basename(f) === "scores.jsonl") continue;
    rows.push(...readJsonl<TrialRow>(f));
  }
  return rows;
}

export function enumerateCells(cfg: SeamConfig, opts: Pick<RunOptions, "conditions" | "questions" | "models" | "modelLine">): Cell[] {
  const models = enabledModels(cfg).filter((m) => !opts.models || opts.models.includes(m.id));
  if (models.length === 0) throw new Error("no enabled models selected");
  const lines = opts.modelLine === "both" ? [true, false] : [opts.modelLine === "on"];
  const cells: Cell[] = [];
  for (const cid of opts.conditions) {
    const condition = cfg.conditions.conditions[cid];
    if (!condition) throw new Error(`unknown condition ${cid}; known: ${Object.keys(cfg.conditions.conditions).join(", ")}`);
    for (const q of cfg.questions) {
      if (opts.questions && !opts.questions.includes(q.id)) continue;
      for (const [a, b] of pairsFor(condition, models)) {
        for (const line of lines) cells.push({ condition, question: q, model_a: a, model_b: b, current_model_line: line });
      }
    }
  }
  return cells;
}

function cellKeyOf(c: Cell): string {
  return cellKey({ condition: c.condition.id, question_id: c.question.id, model_a: c.model_a.id, model_b: c.model_b.id, current_model_line: c.current_model_line });
}

/** C0 pool for plants: successful cold trials of model A on question Q. */
export function plantPool(all: TrialRow[], modelA: ModelEntry, questionId: string): TrialRow[] {
  return all.filter((t) => t.condition === "C0" && t.model_b === modelA.id && t.question_id === questionId && t.extracted_answer !== null && !t.error && t.source === "api");
}

export function pickPlant(pool: TrialRow[], form: "full" | "answer_only", rand: () => number): Plant {
  const t = pool[Math.floor(rand() * pool.length)];
  return { trial_id: t.trial_id, model: t.model_b, text_full: t.raw_response, answer: t.extracted_answer!, form };
}

async function withRetry<T>(fn: () => Promise<T>, log: (s: string) => void, attempts = 5): Promise<T> {
  let delay = 2000;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !isRetryable(e)) throw e;
      const d = describeError(e);
      log(`  retry ${i + 1}/${attempts - 1} after ${d.kind}: ${d.message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60000);
    }
  }
}

export async function runTrial(cfg: SeamConfig, cell: Cell, plant: Plant | null, meta: { run_id: string; trial_id: string; seed_order: TrialRow["seed_order"]; provider: Provider; prereg_commit: string | null; log: (s: string) => void }): Promise<TrialRow> {
  const responder = responderOf(cell);
  const system = systemPrompt(cfg, cell);
  const messages: ChatMessage[] = [...openingMessages(cell, plant)];
  const responses: StepResponse[] = [];
  const flags: string[] = [];
  let error: TrialRow["error"] = null;
  for (let k = 0; k < cell.condition.steps.length; k++) {
    const step = stepMessages(cell, plant, k);
    messages.push(...step);
    try {
      const res = await withRetry(() => complete({ provider: meta.provider, model: responder.id, system, messages, max_tokens: cfg.conditions.defaults.max_tokens }), meta.log);
      responses.push({ step: k, user_text: step.find((m) => m.role === "user")!.content, text: res.text, stop_reason: res.stop_reason, stop_details: res.stop_details ?? null, served_model: res.served_model, usage: res.usage ?? null, request_id: res.request_id ?? null });
      if (res.stop_reason === "refusal") flags.push(`refusal_step_${k}`);
      if (res.stop_reason === "max_tokens") flags.push(`max_tokens_step_${k}`);
      if (res.served_model && meta.provider === "anthropic" && !res.served_model.startsWith(responder.id)) flags.push(`served_model_mismatch_step_${k}:${res.served_model}`);
      messages.push({ role: "assistant", content: res.text });
    } catch (e) {
      error = describeError(e);
      flags.push(`error_step_${k}`);
      break;
    }
  }
  const extractFrom = cell.condition.extract_from ?? Math.max(0, cell.condition.steps.length - 1);
  const target = responses[extractFrom];
  const raw = target?.text ?? "";
  const ex = target ? extractAnswer(raw, cell.question) : { answer: null, method: null, reason: "no response" };
  if (ex.answer === null) flags.push(`extraction_failed:${ex.reason ?? "unknown"}`);
  return {
    trial_id: meta.trial_id,
    run_id: meta.run_id,
    source: "api",
    condition: cell.condition.id,
    question_id: cell.question.id,
    model_a: cell.model_a.id,
    model_b: cell.model_b.id,
    responder_model: responder.id,
    current_model_line: cell.current_model_line,
    seed_order: meta.seed_order,
    system_sent: system,
    messages_sent: messages,
    responses,
    raw_response: raw,
    extract_from: extractFrom,
    extracted_answer: ex.answer,
    extraction_method: ex.method,
    plant: plant ? { trial_id: plant.trial_id, form: plant.form, answer: plant.answer, text: plantText(plant) } : null,
    flags,
    error,
    prereg_commit: meta.prereg_commit,
    timestamp: nowIso(),
    timezone: userTimezone(),
  };
}

export interface RunSummary {
  run_id: string;
  planned: number;
  executed: number;
  skipped_existing: number;
  errors: number;
  flagged: number;
  file: string;
}

export async function runExperiment(cfg: SeamConfig, opts: RunOptions): Promise<RunSummary> {
  const log = opts.log;
  const nonCold = opts.conditions.filter((c) => c !== "C0");
  const pr = preregStatus(cfg.root);
  if (nonCold.length && !(pr.exists && pr.committed && pr.clean)) {
    const why = !pr.exists ? "PREREG.md does not exist" : !pr.committed ? "PREREG.md is not committed" : "PREREG.md has uncommitted edits";
    if (!opts.allowUnfrozenPrereg) throw new Error(`${why}. Conditions ${nonCold.join(", ")} require frozen pre-registration (commit PREREG.md first, or pass --allow-unfrozen-prereg to record the run as unregistered).`);
    log(`WARNING: ${why}; run recorded with prereg_commit=null`);
  }
  // Judge safety is enforced at scoring time; the runner only talks to models under test.
  const all = loadAllTrials(cfg.root);
  const cells = enumerateCells(cfg, opts);
  // Requirements: plant conditions need C0 pools.
  const counts = new Map<string, number>();
  for (const t of all) counts.set(cellKey(t), (counts.get(cellKey(t)) ?? 0) + 1);
  const rand = rng(opts.seed);
  type Job = { cell: Cell; plant: Plant | null; position: number };
  const jobs: Job[] = [];
  let skipped = 0;
  const pending: Array<{ cell: Cell }> = [];
  for (const cell of cells) {
    const have = counts.get(cellKeyOf(cell)) ?? 0;
    skipped += Math.min(have, opts.n);
    for (let i = have; i < opts.n; i++) pending.push({ cell });
  }
  const order = shuffle(pending, rand);
  order.forEach((p, position) => {
    let plant: Plant | null = null;
    if (p.cell.condition.plant) {
      const pool = plantPool(all, p.cell.model_a, p.cell.question.id);
      if (pool.length === 0) throw new Error(`no C0 plants for ${p.cell.model_a.id} on ${p.cell.question.id}; run \`seam run C0\` first`);
      plant = pickPlant(pool, p.cell.condition.plant_form, rand);
    }
    jobs.push({ cell: p.cell, plant, position });
  });
  const run_id = opts.runId ?? `${nowIso().replace(/[:T]/g, "-").slice(0, 19)}-${opts.conditions.join("+")}`;
  const file = path.join(trialsDir(cfg.root), `${run_id}.jsonl`);
  log(`run ${run_id}: ${jobs.length} trials to execute (${skipped} already present), seed ${opts.seed}, model line ${opts.modelLine}, provider ${opts.provider}${opts.dryRun ? ", DRY RUN" : ""}`);
  if (opts.dryRun) {
    for (const j of jobs.slice(0, 5)) {
      const msgs = [...openingMessages(j.cell, j.plant), ...stepMessages(j.cell, j.plant, 0)];
      log(`--- ${j.cell.condition.id} ${j.cell.question.id} A=${j.cell.model_a.id} B=${j.cell.model_b.id} responder=${responderOf(j.cell).id} line=${j.cell.current_model_line} address=${addressName(j.cell) ?? "-"}`);
      log(`system: ${JSON.stringify(systemPrompt(cfg, j.cell))}`);
      for (const m of msgs) log(`${m.role}: ${JSON.stringify(m.content.slice(0, 300))}`);
    }
    if (jobs.length > 5) log(`... and ${jobs.length - 5} more`);
    return { run_id, planned: jobs.length, executed: 0, skipped_existing: skipped, errors: 0, flagged: 0, file };
  }
  let executed = 0, errors = 0, flagged = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const trial_id = `${run_id}-${String(j.position).padStart(4, "0")}`;
      const row = await runTrial(cfg, j.cell, j.plant, { run_id, trial_id, seed_order: { seed: opts.seed, position: j.position, total: jobs.length }, provider: opts.provider, prereg_commit: pr.commit, log });
      appendJsonl(file, row);
      executed++;
      if (row.error) errors++;
      if (row.flags.length) flagged++;
      log(`[${executed}/${jobs.length}] ${row.condition} ${row.question_id} ${row.model_a}→${row.responder_model} line=${row.current_model_line} answer=${JSON.stringify(row.extracted_answer)}${row.flags.length ? ` flags=${row.flags.join(",")}` : ""}${row.error ? ` ERROR ${row.error.kind}: ${row.error.message.slice(0, 100)}` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return { run_id, planned: jobs.length, executed, skipped_existing: skipped, errors, flagged, file };
}
