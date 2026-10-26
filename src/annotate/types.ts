import type { Quote } from "./regex.js";
import type { ParsedTurn } from "../parse/export.js";
import type { ReorderSuggestion } from "../parse/reorder.js";

export interface TurnAnnotation {
  index: number;
  role: "user" | "assistant";
  configured_model: string | null;
  claimed_model: string | null;          // canonical id from the strongest identity self-report in this turn
  claimed_model_quote: string | null;    // verbatim
  user_asserted_model: string | null;    // name the user addressed it by in the preceding user turn
  user_asserted_quote: string | null;
  ownership_claims: Quote[];
  disownments: Quote[];
  identity_self_reports: Quote[];
  mechanism_self_reports: Quote[];
  self_corrections: Quote[];
  overrides: string[];                   // fields set by hand file
}

export type SeamKind =
  | "real"              // configured model changed (needs configured_models)
  | "candidate"         // empty assistant turn (thinking summary only)
  | "sham"              // user asserted a name that differs from the configured model
  | "label";            // user asserted a name; configured model unknown so real/sham undecidable

export interface SeamAnnotation {
  id: string;
  kind: SeamKind;
  /** index of the first assistant turn after the seam */
  at_turn: number;
  /** index of the turn that is the trace of the seam (empty turn, or user tag turn) */
  trace_turn: number | null;
  model_before: string | null;
  model_after: string | null;
  asserted_model: string | null;
  marked: boolean;
  marker_quote: string | null;
  turns_until_first_ownership_of_prior_turn: number | null;
  turns_until_identity_claim: number | null;
  identity_claim_correct: boolean | null;
  identity_claim_quote: string | null;
  turns_until_disownment: number | null;
  notes: string[];
}

export interface RecordMeta {
  type: "meta";
  id: string;
  slug: string;
  source: ParsedTurnSource;
  ingested_at: string;
  timezone: string;
  tool_version: string;
  turn_count: number;
  assistant_turn_count: number;
  warnings: string[];
  configured_models: Array<{ from: number; to: number | null; model: string }>;
  confirmed_order: number[] | null;
  annotated_at?: string;
  judge?: { model: string; provider: string } | null;
  hand_file?: string | null;
}

export type ParsedTurnSource = { model?: string; url?: string; exported_at?: string; message_count?: number; file?: string };

export interface TurnRow extends ParsedTurn {
  type: "turn";
  annotation: TurnAnnotation | null;
}

export interface SeamRow extends SeamAnnotation {
  type: "seam";
}

export interface ReorderRow extends ReorderSuggestion {
  type: "reorder_suggestion";
}

export type RecordRow = RecordMeta | TurnRow | SeamRow | ReorderRow;

/** Hand annotation / override file: records/NNN-slug.hand.json */
export interface HandFile {
  configured_models?: Array<{ from: number; to: number | null; model: string }>;
  turns?: Record<string, Partial<Pick<TurnAnnotation, "claimed_model" | "user_asserted_model">> & {
    candidate_seam?: boolean;
    ownership_claims?: string[];
    disownments?: string[];
    identity_self_reports?: string[];
    mechanism_self_reports?: string[];
    self_corrections?: string[];
    note?: string;
  }>;
  /** Expectations the automatic annotator must reproduce (seam validate). */
  expect?: Array<{
    turn?: number;
    field: "ownership_claims" | "disownments" | "identity_self_reports" | "mechanism_self_reports" | "self_corrections" | "candidate_seam" | "user_asserted_model" | "claimed_model" | "reorder_suggestion" | "seam";
    contains?: string;       // substring that must appear in some quote for that field
    equals?: unknown;        // exact value for scalar fields
    note?: string;
  }>;
  notes?: string[];
}
