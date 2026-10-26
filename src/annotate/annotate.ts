/**
 * Semi-automatic annotation: regex first pass, optional judge second pass,
 * hand overrides win over everything. Produces per-turn annotations and
 * per-seam metrics.
 */
import type { ParsedTurn } from "../parse/export.js";
import { compilePatterns, findAll, modelMentions, type CompiledPatterns, type Quote } from "./regex.js";
import type { HandFile, SeamAnnotation, TurnAnnotation } from "./types.js";
import { modelNameIndex, type SeamConfig } from "../config.js";

export interface ConfiguredRange {
  from: number;
  to: number | null;
  model: string;
}

export function configuredModelAt(ranges: ConfiguredRange[], index: number): string | null {
  for (const r of ranges) if (index >= r.from && (r.to === null || index <= r.to)) return r.model;
  return null;
}

/** Parse "0-164=claude-fable-5-1,166-=claude-opus-5-5" */
export function parseConfiguredModels(spec: string | undefined, cfg: SeamConfig): ConfiguredRange[] {
  if (!spec) return [];
  return spec.split(",").map((part) => {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d*)\s*=\s*(\S+)$/);
    if (!m) throw new Error(`bad --models range ${JSON.stringify(part)}; expected like 0-164=claude-fable-5-1,166-=claude-opus-5-5`);
    const model = m[3];
    if (!cfg.models.under_test.some((x) => x.id === model)) throw new Error(`--models names unknown model ${model}`);
    return { from: Number(m[1]), to: m[2] === "" ? null : Number(m[2]), model };
  });
}

export function buildPatterns(cfg: SeamConfig): CompiledPatterns {
  const idx = modelNameIndex(cfg);
  return compilePatterns(idx.pattern, idx.lookup);
}

function userAssertion(prevUser: ParsedTurn | undefined, cp: CompiledPatterns): { model: string | null; quote: string | null } {
  if (!prevUser) return { model: null, quote: null };
  const hits = findAll(prevUser.content, cp.user_address, cp);
  const hit = hits.find((h) => h.model_ref);
  if (hit) return { model: hit.model_ref!, quote: hit.quote };
  return { model: null, quote: null };
}

export function annotateTurns(
  turns: ParsedTurn[],
  cfg: SeamConfig,
  configured: ConfiguredRange[],
  hand?: HandFile,
): TurnAnnotation[] {
  const cp = buildPatterns(cfg);
  const out: TurnAnnotation[] = [];
  let lastUser: ParsedTurn | undefined;
  let priorAssistantSeen = false;
  for (const t of turns) {
    const a: TurnAnnotation = {
      index: t.index,
      role: t.role,
      configured_model: configuredModelAt(hand?.configured_models?.length ? hand.configured_models : configured, t.index),
      claimed_model: null,
      claimed_model_quote: null,
      user_asserted_model: null,
      user_asserted_quote: null,
      ownership_claims: [],
      disownments: [],
      identity_self_reports: [],
      mechanism_self_reports: [],
      self_corrections: [],
      overrides: [],
    };
    if (t.role === "user") {
      lastUser = t;
      out.push(a);
      continue;
    }
    const ua = userAssertion(lastUser, cp);
    a.user_asserted_model = ua.model;
    a.user_asserted_quote = ua.quote;
    if (!t.empty) {
      // Ownership claims only make sense when there is a prior assistant turn to own.
      a.ownership_claims = priorAssistantSeen ? findAll(t.content, cp.ownership, cp) : [];
      a.disownments = findAll(t.content, cp.disownment, cp);
      a.identity_self_reports = findAll(t.content, cp.identity, cp);
      a.mechanism_self_reports = findAll(t.content, cp.mechanism, cp);
      a.self_corrections = priorAssistantSeen ? findAll(t.content, cp.self_correction, cp) : [];
      // Strongest identity claim: a positive "I'm X" style report naming a model.
      const positive = a.identity_self_reports.find((q) => q.model_ref && !/^id\.im_not_model$/.test(q.pattern));
      if (positive) {
        a.claimed_model = positive.model_ref!;
        a.claimed_model_quote = positive.quote;
      }
    }
    // Hand overrides.
    const h = hand?.turns?.[String(t.index)];
    if (h) {
      const asQuotes = (xs: string[] | undefined): Quote[] | undefined =>
        xs?.map((q) => ({ quote: q, match: q, pattern: "hand", source: "hand" as const, model_ref: modelMentions(q, cp).find((m) => m.id)?.id ?? null }));
      if (h.claimed_model !== undefined) { a.claimed_model = h.claimed_model; a.overrides.push("claimed_model"); }
      if (h.user_asserted_model !== undefined) { a.user_asserted_model = h.user_asserted_model; a.overrides.push("user_asserted_model"); }
      for (const f of ["ownership_claims", "disownments", "identity_self_reports", "mechanism_self_reports", "self_corrections"] as const) {
        const q = asQuotes(h[f]);
        if (q) { a[f] = q; a.overrides.push(f); }
      }
    }
    priorAssistantSeen = true;
    out.push(a);
  }
  return out;
}

function markerBetween(turns: ParsedTurn[], from: number, to: number, cp: CompiledPatterns): string | null {
  for (const t of turns) {
    if (t.index <= from || t.index >= to) continue;
    const hits = findAll(t.raw, cp.marker, cp);
    if (hits.length) return hits[0].quote;
  }
  return null;
}

/** Detect seams and compute per-seam metrics. */
export function detectSeams(turns: ParsedTurn[], ann: TurnAnnotation[], cfg: SeamConfig, hand?: HandFile): SeamAnnotation[] {
  const cp = buildPatterns(cfg);
  const byIndex = new Map(ann.map((a) => [a.index, a]));
  const seams: SeamAnnotation[] = [];
  const assistant = turns.filter((t) => t.role === "assistant");
  let n = 0;
  const mk = (partial: Partial<SeamAnnotation> & Pick<SeamAnnotation, "kind" | "at_turn">): SeamAnnotation => ({
    id: `S${String(++n).padStart(2, "0")}`,
    trace_turn: null,
    model_before: null,
    model_after: null,
    asserted_model: null,
    marked: false,
    marker_quote: null,
    turns_until_first_ownership_of_prior_turn: null,
    turns_until_identity_claim: null,
    identity_claim_correct: null,
    identity_claim_quote: null,
    turns_until_disownment: null,
    notes: [],
    ...partial,
  });

  for (let i = 1; i < assistant.length; i++) {
    const prev = assistant[i - 1];
    const cur = assistant[i];
    const pa = byIndex.get(prev.index)!;
    const ca = byIndex.get(cur.index)!;
    const handSeam = hand?.turns?.[String(prev.index)]?.candidate_seam;

    // Real seam: configured model changes.
    if (pa.configured_model && ca.configured_model && pa.configured_model !== ca.configured_model) {
      seams.push(mk({ kind: "real", at_turn: cur.index, trace_turn: prev.empty ? prev.index : null, model_before: pa.configured_model, model_after: ca.configured_model }));
      continue;
    }
    // Candidate: the previous assistant turn is empty (thinking summary only).
    if (prev.empty || handSeam) {
      seams.push(mk({ kind: "candidate", at_turn: cur.index, trace_turn: prev.index, model_before: pa.configured_model, model_after: ca.configured_model, notes: [prev.empty ? `turn ${prev.index} is an empty assistant turn (thinking summary only)` : `hand file marks turn ${prev.index} as candidate seam`] }));
      continue;
    }
    // Sham / label: the user addressed the assistant by a model name.
    if (ca.user_asserted_model) {
      const configured = ca.configured_model;
      if (configured && ca.user_asserted_model !== configured) {
        seams.push(mk({ kind: "sham", at_turn: cur.index, trace_turn: cur.index - 1, model_before: configured, model_after: configured, asserted_model: ca.user_asserted_model, notes: [`user addressed the assistant as ${ca.user_asserted_model}; configured model is ${configured}`] }));
      } else if (!configured) {
        // Only when the asserted name changes relative to the last assertion.
        const prevAsserted = [...ann].filter((a) => a.role === "assistant" && a.index < cur.index && a.user_asserted_model).at(-1)?.user_asserted_model ?? null;
        if (prevAsserted !== ca.user_asserted_model) {
          seams.push(mk({ kind: "label", at_turn: cur.index, trace_turn: cur.index - 1, asserted_model: ca.user_asserted_model, notes: [`user addressed the assistant as ${ca.user_asserted_model}; configured model unknown (pass --models to decide real vs sham)`] }));
        }
      }
    }
  }

  // Metrics per seam.
  for (const s of seams) {
    const post = assistant.filter((t) => t.index >= s.at_turn);
    const pre = assistant.filter((t) => t.index < s.at_turn).at(-1);
    if (pre) {
      const mq = markerBetween(turns, pre.index, s.at_turn, cp);
      if (mq) { s.marked = true; s.marker_quote = mq; }
    }
    post.forEach((t, k) => {
      const a = byIndex.get(t.index)!;
      if (s.turns_until_first_ownership_of_prior_turn === null && a.ownership_claims.length) s.turns_until_first_ownership_of_prior_turn = k;
      if (s.turns_until_disownment === null && a.disownments.length) s.turns_until_disownment = k;
      if (s.turns_until_identity_claim === null && a.identity_self_reports.length) {
        s.turns_until_identity_claim = k;
        s.identity_claim_quote = a.claimed_model_quote ?? a.identity_self_reports[0].quote;
        const configured = a.configured_model ?? s.model_after;
        s.identity_claim_correct = a.claimed_model && configured ? a.claimed_model === configured : null;
      }
    });
  }
  return seams;
}
