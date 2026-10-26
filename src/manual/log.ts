/**
 * `seam log-manual`: enter a hand-run claude.ai trial into the same JSONL
 * schema. Interactive prompts, or --from <json> for a prepared form (see
 * protocol/manual-run.md for the form).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { questionById, type SeamConfig } from "../config.js";
import { appendJsonl } from "../util/jsonl.js";
import { nowIso, userTimezone } from "../util/time.js";
import { extractAnswer } from "../score/extract.js";
import type { TrialRow } from "../run/trial.js";
import { trialsDir } from "../run/runner.js";
import { preregStatus } from "../run/prereg.js";

export interface ManualForm {
  condition: string;
  question_id: string;
  model_a: string;
  model_b: string;
  responder_model?: string;
  current_model_line?: boolean;   // the app always has it; default true
  plant_text?: string;            // the first model's full reply (for plant conditions)
  user_turns: string[];           // what you typed, in order (after the plant)
  responses: string[];            // what the responder said, in order
  screenshots: string[];
  notes?: string;
  app_url?: string;
  timestamp?: string;             // when you ran it, ISO 8601 with offset
}

export function manualFile(root: string): string {
  return path.join(trialsDir(root), "manual.jsonl");
}

export function formToRow(cfg: SeamConfig, form: ManualForm, trial_id: string): TrialRow {
  const c = cfg.conditions.conditions[form.condition];
  if (!c) throw new Error(`unknown condition ${form.condition}`);
  const q = questionById(cfg, form.question_id);
  const responder = form.responder_model ?? (c.responder === "A" ? form.model_a : form.model_b);
  if (form.user_turns.length !== form.responses.length) throw new Error(`user_turns (${form.user_turns.length}) and responses (${form.responses.length}) must pair up`);
  const messages: TrialRow["messages_sent"] = [];
  let plant: TrialRow["plant"] = null;
  if (c.plant) {
    if (!form.plant_text) throw new Error(`condition ${form.condition} needs plant_text`);
    const pa = extractAnswer(form.plant_text, q);
    if (pa.answer === null) throw new Error(`could not extract the plant's answer from plant_text (${pa.reason}); paste the full first reply`);
    messages.push({ role: "user", content: q.text }, { role: "assistant", content: form.plant_text });
    plant = { trial_id: "manual-plant", form: "full", answer: pa.answer, text: form.plant_text };
  }
  const responses: TrialRow["responses"] = [];
  form.user_turns.forEach((u, k) => {
    messages.push({ role: "user", content: u });
    messages.push({ role: "assistant", content: form.responses[k] });
    responses.push({ step: k, user_text: u, text: form.responses[k], stop_reason: null, served_model: null });
  });
  const extractFrom = c.extract_from ?? Math.max(0, responses.length - 1);
  const raw = responses[extractFrom]?.text ?? "";
  const ex = extractAnswer(raw, q);
  const flags: string[] = ["manual"];
  if (ex.answer === null) flags.push(`extraction_failed:${ex.reason}`);
  if (form.screenshots.length === 0) flags.push("no_screenshots");
  const pr = preregStatus(cfg.root);
  return {
    trial_id,
    run_id: "manual",
    source: "manual",
    condition: form.condition,
    question_id: form.question_id,
    model_a: form.model_a,
    model_b: form.model_b,
    responder_model: responder,
    current_model_line: form.current_model_line ?? true,
    seed_order: null,
    system_sent: "(claude.ai app system prompt; includes the configured-model line)",
    messages_sent: messages,
    responses,
    raw_response: raw,
    extract_from: extractFrom,
    extracted_answer: ex.answer,
    extraction_method: ex.method,
    plant,
    flags,
    error: null,
    prereg_commit: pr.commit,
    timestamp: form.timestamp ?? nowIso(),
    timezone: userTimezone(),
    manual: { screenshots: form.screenshots, notes: form.notes ?? "", app_url: form.app_url },
  };
}

export async function interactiveForm(cfg: SeamConfig): Promise<ManualForm> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, dflt?: string) => { const a = (await rl.question(dflt ? `${q} [${dflt}]: ` : `${q}: `)).trim(); return a || dflt || ""; };
  const multi = async (label: string) => {
    console.log(`${label} (paste, then a line with only "." to finish):`);
    const lines: string[] = [];
    for (;;) { const l = await rl.question(""); if (l.trim() === ".") break; lines.push(l); }
    return lines.join("\n").trim();
  };
  try {
    const condition = await ask(`condition (${Object.keys(cfg.conditions.conditions).join("/")})`, "C3");
    const c = cfg.conditions.conditions[condition];
    if (!c) throw new Error(`unknown condition ${condition}`);
    const question_id = await ask(`question (${cfg.questions.map((q) => q.id).join("/")})`, "Q1");
    const ids = cfg.models.under_test.map((m) => m.id).join("/");
    const model_a = await ask(`model A id (${ids})`);
    const model_b = await ask(`model B id (${ids})`, model_a);
    let plant_text: string | undefined;
    if (c.plant) plant_text = await multi("Plant: paste model A's full first reply");
    const user_turns: string[] = [], responses: string[] = [];
    for (let k = 0; k < c.steps.length; k++) {
      user_turns.push(await multi(`User turn ${k + 1} of ${c.steps.length} exactly as typed in the app`));
      responses.push(await multi(`Responder's reply to turn ${k + 1}`));
    }
    const shots = (await ask("screenshot paths, comma separated")).split(",").map((s) => s.trim()).filter(Boolean);
    const notes = await ask("notes", "");
    const app_url = await ask("claude.ai chat URL", "");
    const timestamp = await ask("timestamp (ISO 8601 with offset)", nowIso());
    return { condition, question_id, model_a, model_b, plant_text, user_turns, responses, screenshots: shots, notes, app_url: app_url || undefined, timestamp, current_model_line: true };
  } finally {
    rl.close();
  }
}

export function logManual(cfg: SeamConfig, form: ManualForm): TrialRow {
  const file = manualFile(cfg.root);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  const row = formToRow(cfg, form, `M-${String(existing + 1).padStart(4, "0")}`);
  appendJsonl(file, row);
  return row;
}
