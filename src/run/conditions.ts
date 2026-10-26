/**
 * Turns a (condition, question, model pair, flags) cell into the exact message
 * list sent to the API. Pure; no I/O. The runner appends live responses between
 * steps.
 */
import { currentModelLine, type Condition, type ModelEntry, type Question, type SeamConfig } from "../config.js";
import type { ChatMessage } from "./client.js";
import { lowerFirst } from "../util/text.js";

export interface Plant {
  trial_id: string;        // the C0 trial the plant text came from
  model: string;           // model A id
  text_full: string;       // A's whole response
  answer: string | number; // A's extracted answer
  form: "full" | "answer_only";
}

export interface Cell {
  condition: Condition;
  question: Question;
  model_a: ModelEntry;
  model_b: ModelEntry;
  current_model_line: boolean;
}

export function responderOf(cell: Cell): ModelEntry {
  return cell.condition.responder === "A" ? cell.model_a : cell.model_b;
}

/** Which name goes into {address}. */
export function addressName(cell: Cell): string | null {
  const c = cell.condition;
  switch (c.address_name) {
    case "none": return null;
    case "A": return cell.model_a.display_name;
    case "B": return cell.model_b.display_name;
    case "other": {
      const responder = responderOf(cell);
      return responder.id === cell.model_a.id ? cell.model_b.display_name : cell.model_a.display_name;
    }
  }
}

export function renderTemplate(tpl: string, cell: Cell, plant: Plant | null): string {
  const q = cell.question;
  const addr = addressName(cell);
  const vars: Record<string, string> = {
    question: q.text,
    followup_passive: q.followup_passive,
    followup_invited: q.followup_invited,
    followup_invited_lower: lowerFirst(q.followup_invited),
    address: addr ?? "",
    answer: plant ? String(plant.answer) : "",
    answer_noun: q.answer_noun,
    model_a_name: cell.model_a.display_name,
    model_b_name: cell.model_b.display_name,
    responder_name: responderOf(cell).display_name,
  };
  const out = tpl.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (!(k in vars)) throw new Error(`conditions.yaml: unknown template variable {${k}} in ${JSON.stringify(tpl)}`);
    return vars[k];
  });
  if (addr === null && /\{address\}/.test(tpl)) throw new Error(`condition ${cell.condition.id} uses {address} but address_name is none`);
  return out;
}

export function plantText(plant: Plant): string {
  return plant.form === "answer_only" ? String(plant.answer) : plant.text_full;
}

export function systemPrompt(cfg: SeamConfig, cell: Cell): string {
  const parts: string[] = [];
  if (cfg.conditions.defaults.system_base) parts.push(cfg.conditions.defaults.system_base);
  if (cell.current_model_line) parts.push(currentModelLine(cfg, responderOf(cell).id));
  return parts.join("\n\n");
}

/** Opening messages before the first live step. */
export function openingMessages(cell: Cell, plant: Plant | null): ChatMessage[] {
  if (!cell.condition.plant) return [];
  if (!plant) throw new Error(`condition ${cell.condition.id} needs a plant`);
  return [
    { role: "user", content: cell.question.text },
    { role: "assistant", content: plantText(plant) },
  ];
}

/**
 * Messages to append for step k (0-based) before calling the responder.
 * The marker (C6) attaches to the first step only.
 */
export function stepMessages(cell: Cell, plant: Plant | null, k: number): ChatMessage[] {
  const c = cell.condition;
  const text = renderTemplate(c.steps[k], cell, plant);
  if (k === 0 && c.marker) {
    const marker = renderTemplate(c.marker, cell, plant);
    if (c.marker_mode === "system_last") {
      return [{ role: "user", content: text }, { role: "system", content: marker }];
    }
    return [{ role: "user", content: `${marker}\n\n${text}` }];
  }
  return [{ role: "user", content: text }];
}

/** Enumerate the ordered model pairs a condition runs for. */
export function pairsFor(condition: Condition, models: ModelEntry[]): Array<[ModelEntry, ModelEntry]> {
  const out: Array<[ModelEntry, ModelEntry]> = [];
  for (const a of models) for (const b of models) {
    if (condition.pairs === "same" && a.id !== b.id) continue;
    if (condition.pairs === "different" && a.id === b.id) continue;
    out.push([a, b]);
  }
  return out;
}

/** Stable cell key used for counting existing trials (resume / bump n). */
export function cellKey(c: { condition: string; question_id: string; model_a: string; model_b: string; current_model_line: boolean }): string {
  return `${c.condition}|${c.question_id}|${c.model_a}|${c.model_b}|${c.current_model_line ? "line" : "noline"}`;
}
