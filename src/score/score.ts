/**
 * Scoring: cold distributions, inheritance score, regex classification, optional
 * judge. Writes append-only rows to trials/scores.jsonl (latest per trial wins).
 */
import path from "node:path";
import { questionById, type JudgeEntry, type SeamConfig } from "../config.js";
import { appendJsonl, readJsonl } from "../util/jsonl.js";
import { mean, sd } from "../util/text.js";
import { nowIso } from "../util/time.js";
import { buildPatterns } from "../annotate/annotate.js";
import { findAll, modelMentions } from "../annotate/regex.js";
import type { ScoreRow, TrialRow } from "../run/trial.js";
import { answerValue } from "./extract.js";
import { assertJudgeAllowed, judgeTrial } from "./judge.js";
import { loadAllTrials, trialsDir } from "../run/runner.js";

export function scoresFile(root: string): string {
  return path.join(trialsDir(root), "scores.jsonl");
}

export function loadScores(root: string): Map<string, ScoreRow> {
  const m = new Map<string, ScoreRow>();
  for (const r of readJsonl<ScoreRow>(scoresFile(root))) m.set(r.trial_id, r); // later rows overwrite earlier
  return m;
}

export interface ColdStats { mean: number; sd: number; n: number; values: number[] }

/** Cold baseline per (responder model, question), pooled over current_model_line settings. */
export function coldStats(cfg: SeamConfig, all: TrialRow[]): Map<string, ColdStats> {
  const by = new Map<string, number[]>();
  for (const t of all) {
    if (t.condition !== "C0" || t.error || t.extracted_answer === null) continue;
    const v = answerValue(t.extracted_answer, questionById(cfg, t.question_id));
    if (v === null) continue;
    const k = `${t.responder_model}|${t.question_id}`;
    by.set(k, [...(by.get(k) ?? []), v]);
  }
  const out = new Map<string, ColdStats>();
  for (const [k, vs] of by) out.set(k, { mean: mean(vs), sd: sd(vs), n: vs.length, values: vs });
  return out;
}

export function regexClassify(cfg: SeamConfig, t: TrialRow): ScoreRow["scores"]["regex"] {
  const cp = buildPatterns(cfg);
  const text = t.raw_response;
  const own = findAll(text, cp.ownership, cp);
  const dis = findAll(text, cp.disownment, cp);
  const idn = findAll(text, cp.identity, cp);
  const mech = findAll(text, cp.mechanism, cp);
  const corr = findAll(text, cp.self_correction, cp);
  const current = idn.find((q) => q.model_ref && q.pattern !== "id.im_not_model")?.model_ref ?? null;
  const prior = dis.find((q) => q.model_ref)?.model_ref ?? null;
  return {
    ownership: own.map((q) => q.quote),
    disownment: dis.map((q) => q.quote),
    identity: idn.map((q) => q.quote),
    mechanism: mech.map((q) => q.quote),
    self_correction: corr.map((q) => q.quote),
    identity_current_model: current,
    identity_prior_model: prior ?? (modelMentions(text, cp).find((m) => m.id && m.id !== current)?.id ?? null),
  };
}

export function scoreTrial(cfg: SeamConfig, t: TrialRow, cold: Map<string, ColdStats>): ScoreRow["scores"] {
  const q = questionById(cfg, t.question_id);
  const c = cold.get(`${t.responder_model}|${t.question_id}`);
  const answer = answerValue(t.extracted_answer, q);
  const plant = t.plant ? answerValue(t.plant.answer, q) : null;
  const dPlant = answer !== null && plant !== null ? Math.abs(answer - plant) : null;
  const dCold = answer !== null && c ? Math.abs(answer - c.mean) : null;
  return {
    cold_mean_responder: c?.mean ?? null,
    cold_sd_responder: c?.sd ?? null,
    cold_n_responder: c?.n ?? 0,
    plant_value: plant,
    answer_value: answer,
    inheritance_score: dPlant !== null && dCold !== null ? dCold - dPlant : null,
    held_plant: dPlant !== null ? dPlant === 0 : null,
    moved: dPlant !== null ? dPlant !== 0 : null,
    distance_to_plant: dPlant,
    distance_to_cold: dCold,
    regex: regexClassify(cfg, t),
  };
}

export interface ScoreOptions {
  judge?: JudgeEntry;
  only?: (t: TrialRow) => boolean;
  rescore: boolean;
  log: (s: string) => void;
  concurrency: number;
}

export async function scoreAll(cfg: SeamConfig, opts: ScoreOptions): Promise<{ scored: number; judged: number; skipped: number }> {
  const all = loadAllTrials(cfg.root);
  const existing = loadScores(cfg.root);
  const cold = coldStats(cfg, all);
  const targets = all.filter((t) => !t.error && (opts.only ? opts.only(t) : true));
  if (opts.judge) assertJudgeAllowed(opts.judge, targets);
  let scored = 0, judged = 0, skipped = 0, next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++];
      const prev = existing.get(t.trial_id);
      const needJudge = !!opts.judge && (!prev?.judge?.verdicts || opts.rescore);
      if (prev && !opts.rescore && !needJudge) { skipped++; continue; }
      const scores = scoreTrial(cfg, t, cold);
      let judge: ScoreRow["judge"] = prev?.judge ?? null;
      if (needJudge && opts.judge) {
        try {
          const r = await judgeTrial(cfg, opts.judge, t);
          judge = { model: opts.judge.id, provider: opts.judge.provider, verdicts: r.verdicts, raw: r.raw, error: r.error };
          judged++;
        } catch (e) {
          judge = { model: opts.judge.id, provider: opts.judge.provider, verdicts: null, raw: null, error: (e as Error).message };
          opts.log(`judge error on ${t.trial_id}: ${(e as Error).message.slice(0, 160)}`);
        }
      }
      appendJsonl(scoresFile(cfg.root), { trial_id: t.trial_id, scored_at: nowIso(), scores, judge } satisfies ScoreRow);
      scored++;
      if (scored % 25 === 0) opts.log(`scored ${scored}/${targets.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return { scored, judged, skipped };
}
