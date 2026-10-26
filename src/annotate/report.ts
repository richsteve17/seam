import type { LoadedRecord } from "./records.js";
import type { Quote } from "./regex.js";

function fmtQuotes(qs: Quote[]): string {
  if (!qs.length) return "—";
  return qs.map((q) => `“${q.quote.replace(/\n+/g, " ").slice(0, 220)}” _(${q.source}${q.model_ref ? `, ${q.model_ref}` : ""})_`).join("<br>");
}

export function renderRecordMarkdown(rec: LoadedRecord): string {
  const { meta, turns, seams, reorder } = rec;
  const lines: string[] = [];
  lines.push(`# Record ${meta.id} — ${meta.slug}`);
  lines.push("");
  lines.push(`- Source: ${meta.source.file ?? "?"}${meta.source.url ? ` (${meta.source.url})` : ""}`);
  lines.push(`- Exported: ${meta.source.exported_at ?? "?"} · Ingested: ${meta.ingested_at} (${meta.timezone})`);
  lines.push(`- Turns: ${meta.turn_count} (${meta.assistant_turn_count} assistant)`);
  lines.push(`- Configured models: ${meta.configured_models.length ? meta.configured_models.map((r) => `${r.from}–${r.to ?? "end"} ${r.model}`).join(", ") : "unknown (pass --models)"}`);
  lines.push(`- Confirmed order: ${meta.confirmed_order ? "yes (applied)" : "no (file order kept)"}`);
  lines.push(`- Annotated: ${meta.annotated_at ?? "not yet"}${meta.judge ? ` · judge: ${meta.judge.model}` : " · regex only"}${meta.hand_file ? ` · hand overrides: ${meta.hand_file}` : ""}`);
  if (meta.warnings.length) {
    lines.push("");
    lines.push("## Parser warnings");
    for (const w of meta.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  lines.push("## Seams");
  if (!seams.length) lines.push("None detected.");
  else {
    lines.push("| id | kind | at turn | trace | before → after | asserted | marked | turns→ownership | turns→disownment | turns→identity | identity correct |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const s of seams) {
      lines.push(`| ${s.id} | ${s.kind} | ${s.at_turn} | ${s.trace_turn ?? "—"} | ${s.model_before ?? "?"} → ${s.model_after ?? "?"} | ${s.asserted_model ?? "—"} | ${s.marked ? "yes" : "no"} | ${s.turns_until_first_ownership_of_prior_turn ?? "—"} | ${s.turns_until_disownment ?? "—"} | ${s.turns_until_identity_claim ?? "—"} | ${s.identity_claim_correct === null ? "n/a" : s.identity_claim_correct ? "yes" : "no"} |`);
    }
    for (const s of seams) {
      if (s.notes.length || s.marker_quote || s.identity_claim_quote) {
        lines.push("");
        lines.push(`**${s.id}** ${s.notes.join("; ")}${s.marker_quote ? ` Marker: “${s.marker_quote}”` : ""}${s.identity_claim_quote ? ` Identity claim: “${s.identity_claim_quote}”` : ""}`);
      }
    }
  }
  lines.push("");
  lines.push("## Reorder suggestions (not applied)");
  if (!reorder.length) lines.push("None.");
  else for (const r of reorder) lines.push(`- turn ${r.turn} → after user turn ${r.suggested_after === -1 ? "?" : r.suggested_after} (${r.reason}, ${r.confidence}): ${r.evidence}`);
  lines.push("");
  lines.push("## Cleaning");
  const cleaned = turns.filter((t) => t.cleaning_notes.length);
  lines.push(`- ${turns.filter((t) => t.stripped_prefix).length} assistant turns had the "Claude responded:" prefix stripped`);
  lines.push(`- ${turns.filter((t) => t.thinking_summary.length).length} turns had inlined thinking summaries split out`);
  lines.push(`- ${turns.filter((t) => t.role === "assistant" && t.empty).length} empty assistant turns (candidate seams): ${turns.filter((t) => t.role === "assistant" && t.empty).map((t) => t.index).join(", ") || "none"}`);
  if (cleaned.length) lines.push(`- turns with cleaning notes: ${cleaned.map((t) => t.index).join(", ")}`);
  lines.push("");
  lines.push("## Assistant turns with annotations");
  lines.push("");
  const annotated = turns.filter((t) => t.role === "assistant" && t.annotation && (
    t.annotation.ownership_claims.length || t.annotation.disownments.length || t.annotation.identity_self_reports.length ||
    t.annotation.mechanism_self_reports.length || t.annotation.self_corrections.length || t.annotation.user_asserted_model || t.candidate_seam));
  if (!annotated.length) lines.push("No annotations yet. Run `seam annotate <id>`.");
  for (const t of annotated) {
    const a = t.annotation!;
    lines.push(`### Turn ${t.index}${t.candidate_seam ? " — EMPTY (candidate seam)" : ""}`);
    lines.push(`- configured_model: ${a.configured_model ?? "?"} · claimed_model: ${a.claimed_model ?? "—"} · user_asserted_model: ${a.user_asserted_model ?? "—"}${a.user_asserted_quote ? ` (“${a.user_asserted_quote.slice(0, 120)}”)` : ""}`);
    if (t.thinking_summary.length) lines.push(`- thinking_summary: ${t.thinking_summary.map((s) => `“${s}”`).join(", ")}`);
    lines.push(`- ownership_claims: ${fmtQuotes(a.ownership_claims)}`);
    lines.push(`- disownments: ${fmtQuotes(a.disownments)}`);
    lines.push(`- identity_self_reports: ${fmtQuotes(a.identity_self_reports)}`);
    lines.push(`- mechanism_self_reports: ${fmtQuotes(a.mechanism_self_reports)}`);
    lines.push(`- self_corrections: ${fmtQuotes(a.self_corrections)}`);
    if (a.overrides.length) lines.push(`- hand overrides: ${a.overrides.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
