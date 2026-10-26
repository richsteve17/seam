/** Trial row schema (one JSONL row per trial). Raw responses are never overwritten. */
import type { ChatMessage } from "./client.js";

export interface StepResponse {
  step: number;
  user_text: string;
  text: string;
  stop_reason: string | null;
  stop_details?: unknown;
  served_model: string | null;
  usage?: unknown;
  request_id?: string | null;
}

export interface TrialRow {
  trial_id: string;
  run_id: string;
  source: "api" | "manual";
  condition: string;
  question_id: string;
  model_a: string;
  model_b: string;
  responder_model: string;
  current_model_line: boolean;
  seed_order: { seed: number; position: number; total: number } | null;
  system_sent: string;
  messages_sent: ChatMessage[];        // the final request's full message list
  responses: StepResponse[];           // every live response, in order
  raw_response: string;                // the response extraction uses (responses[extract_from])
  extract_from: number;
  extracted_answer: string | number | null;
  extraction_method: string | null;
  plant: { trial_id: string; form: "full" | "answer_only"; answer: string | number; text: string } | null;
  flags: string[];                     // e.g. extraction_failed, refusal, max_tokens, served_model_mismatch
  error: { kind: string; status: number | null; message: string } | null;
  prereg_commit: string | null;
  timestamp: string;
  timezone: string;
  manual?: { screenshots: string[]; notes: string; app_url?: string } | null;
}

/** Append-only scoring rows (trials/scores.jsonl). Latest row per trial_id wins. */
export interface ScoreRow {
  trial_id: string;
  scored_at: string;
  scores: {
    cold_mean_responder: number | null;
    cold_sd_responder: number | null;
    cold_n_responder: number;
    plant_value: number | null;
    answer_value: number | null;
    inheritance_score: number | null;   // |answer - cold_mean_B| - |answer - plant|
    held_plant: boolean | null;         // answer == plant
    moved: boolean | null;              // answer != plant
    distance_to_plant: number | null;
    distance_to_cold: number | null;
    regex: {
      ownership: string[];
      disownment: string[];
      identity: string[];
      mechanism: string[];
      self_correction: string[];
      identity_current_model: string | null;  // canonical id the response claims to be
      identity_prior_model: string | null;    // canonical id it attributes the prior turn to
    };
  };
  judge: {
    model: string;
    provider: string;
    verdicts: JudgeVerdicts | null;
    raw: string | null;
    error: string | null;
  } | null;
}

export interface JudgeVerdicts {
  ownership: { present: boolean; quote: string | null };
  disownment: { present: boolean; quote: string | null; model_named: string | null };
  identity_current: { claimed: string | null; quote: string | null };
  identity_prior: { claimed: string | null; quote: string | null };
  mechanism: { present: boolean; quote: string | null; checkable: boolean | null; holds: boolean | null; reason: string | null };
  holds_position: boolean | null;
  notes: string | null;
}
