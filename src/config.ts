import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { projectRoot } from "./util/env.js";

export interface ModelEntry {
  id: string;
  display_name: string;
  short_name: string;
  family: string;
  aliases: string[];
  enabled: boolean;
}

export interface JudgeEntry {
  id: string;
  display_name: string;
  provider: "anthropic" | "openai-compatible" | "mock";
  enabled: boolean;
}

export interface ModelsConfig {
  under_test: ModelEntry[];
  judges: JudgeEntry[];
  current_model_line_template: string;
}

export interface Question {
  id: string;
  kind: "numeric" | "binary";
  answer_noun: string;
  scale?: [number, number];
  options?: string[];
  option_patterns?: Record<string, string>;
  text: string;
  followup_passive: string;
  followup_invited: string;
}

export interface ConditionRaw {
  name: string;
  plant?: boolean;
  plant_form?: "full" | "answer_only";
  responder?: "A" | "B";
  pairs?: "all" | "different" | "same";
  address_name?: "none" | "A" | "B" | "other";
  marker?: string;
  marker_mode?: "user_prefix" | "system_last";
  steps?: string[];
  extends?: string;
  requires?: string[];
  measures?: string;
  extract_from?: number;
}

export interface Condition extends Required<Omit<ConditionRaw, "extends" | "marker" | "extract_from" | "requires">> {
  id: string;
  marker?: string;
  extract_from?: number;
  requires: string[];
  /** The condition id this one was derived from, if any (for the report). */
  derived_from?: string;
}

export interface ConditionsConfig {
  defaults: { n: number; max_tokens: number; system_base: string; marker_mode: "user_prefix" | "system_last" };
  conditions: Record<string, Condition>;
}

export interface SeamConfig {
  root: string;
  models: ModelsConfig;
  questions: Question[];
  conditions: ConditionsConfig;
}

function readYaml<T>(file: string): T {
  return YAML.parse(fs.readFileSync(file, "utf8")) as T;
}

/** Resolve `extends` chains into flat condition objects. */
function resolveConditions(raw: Record<string, ConditionRaw>, defaults: ConditionsConfig["defaults"]): Record<string, Condition> {
  const out: Record<string, Condition> = {};
  const resolve = (id: string, seen: string[] = []): Condition => {
    if (out[id]) return out[id];
    if (seen.includes(id)) throw new Error(`conditions.yaml: circular extends at ${[...seen, id].join(" -> ")}`);
    const r = raw[id];
    if (!r) throw new Error(`conditions.yaml: ${seen.at(-1) ?? "?"} extends unknown condition ${id}`);
    let base: Condition | undefined;
    if (r.extends) base = resolve(r.extends, [...seen, id]);
    const c: Condition = {
      id,
      name: r.name ?? base?.name ?? id,
      plant: r.plant ?? base?.plant ?? false,
      plant_form: r.plant_form ?? base?.plant_form ?? "full",
      responder: r.responder ?? base?.responder ?? "B",
      pairs: r.pairs ?? base?.pairs ?? "all",
      address_name: r.address_name ?? base?.address_name ?? "none",
      marker: r.marker ?? base?.marker,
      marker_mode: r.marker_mode ?? base?.marker_mode ?? defaults.marker_mode,
      steps: [...(base?.steps ?? []), ...(r.steps ?? [])],
      requires: r.requires ?? base?.requires ?? (id === "C0" ? [] : ["C0"]),
      measures: r.measures ?? base?.measures ?? "",
      extract_from: r.extract_from ?? base?.extract_from,
      derived_from: r.extends,
    };
    if (c.steps.length === 0) throw new Error(`conditions.yaml: ${id} has no steps`);
    out[id] = c;
    return c;
  };
  for (const id of Object.keys(raw)) resolve(id);
  return out;
}

export function loadConfig(root: string = projectRoot()): SeamConfig {
  const cfgDir = path.join(root, "config");
  const models = readYaml<ModelsConfig>(path.join(cfgDir, "models.yaml"));
  const questions = readYaml<{ questions: Question[] }>(path.join(cfgDir, "questions.yaml")).questions;
  const condRaw = readYaml<{ defaults: ConditionsConfig["defaults"]; conditions: Record<string, ConditionRaw> }>(
    path.join(cfgDir, "conditions.yaml"),
  );
  const d = (condRaw.defaults ?? {}) as Partial<ConditionsConfig["defaults"]>;
  const defaults: ConditionsConfig["defaults"] = {
    n: d.n ?? 10,
    max_tokens: d.max_tokens ?? 4096,
    system_base: d.system_base ?? "",
    marker_mode: d.marker_mode ?? "user_prefix",
  };
  for (const q of questions) {
    if (!q.id || !q.kind || !q.text) throw new Error(`questions.yaml: question missing id/kind/text: ${JSON.stringify(q)}`);
    if (q.kind === "binary" && (!q.options || q.options.length < 2)) throw new Error(`questions.yaml: ${q.id} binary needs options`);
    if (!q.answer_noun) q.answer_noun = q.kind === "numeric" ? "number" : "answer";
  }
  for (const m of models.under_test) {
    if (!m.id || !m.display_name) throw new Error(`models.yaml: under_test entry missing id/display_name`);
    m.aliases ??= [];
    m.enabled ??= true;
  }
  for (const j of models.judges) j.enabled ??= true;
  return { root, models, questions, conditions: { defaults, conditions: resolveConditions(condRaw.conditions, defaults) } };
}

export function enabledModels(cfg: SeamConfig): ModelEntry[] {
  return cfg.models.under_test.filter((m) => m.enabled);
}

export function modelById(cfg: SeamConfig, id: string): ModelEntry {
  const m = cfg.models.under_test.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model id ${id} (add it to config/models.yaml)`);
  return m;
}

export function questionById(cfg: SeamConfig, id: string): Question {
  const q = cfg.questions.find((x) => x.id === id);
  if (!q) throw new Error(`unknown question id ${id}`);
  return q;
}

export function currentModelLine(cfg: SeamConfig, modelId: string): string {
  return cfg.models.current_model_line_template.replace("{id}", modelId);
}

/** All known model names (display, short, aliases) -> canonical id, for the annotator's regexes. */
export function modelNameIndex(cfg: SeamConfig): { pattern: RegExp; lookup: (s: string) => string | null } {
  const entries: Array<[string, string]> = [];
  for (const m of cfg.models.under_test) {
    const names = new Set([m.display_name, m.short_name, ...m.aliases, m.id]);
    for (const n of names) entries.push([n.toLowerCase(), m.id]);
  }
  // Longest names first so "Opus 5.5" wins over "Opus".
  entries.sort((a, b) => b[0].length - a[0].length);
  const alts = entries.map(([n]) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"));
  // Bare version tags like "4.6" need a word-ish boundary so "5.5" in "15.5" doesn't match.
  const pattern = new RegExp(`(?<![\\w.])(?:${alts.join("|")})(?![\\w.])`, "gi");
  const lookup = (s: string): string | null => {
    const key = s.toLowerCase().replace(/\s+/g, " ").trim();
    for (const [n, id] of entries) if (n.replace(/\s+/g, " ") === key) return id;
    return null;
  };
  return { pattern, lookup };
}
