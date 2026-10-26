# SEAM — model handoff & turn-attribution tracker + experiment runner

**seam** (n.): the one turn boundary where the serving model changed and the transcript doesn't say so.

SEAM does two things:

1. **Tracker (Part A).** Ingests exported claude.ai transcripts, cleans the export quirks, finds seams (real, candidate, sham), and annotates every assistant turn for ownership claims, disownments, identity self-reports, mechanism self-reports and self-corrections. Regex first pass, optional LLM judge second pass, hand overrides win.
2. **Experiment runner (Part B).** Reproduces the handoff mechanics through the Anthropic Messages API (assistant turns written by model A, then model B responds) and runs the pre-registered conditions C0–C9 that test whether a model's positions and sense of "which turns are mine" come from its weights or from labels in the context window.

Part C, the **manual arm**, is a step sheet for running the core conditions by hand in the app (`protocol/manual-run.md`) and a logger that writes those runs into the same schema.

Owner: Steve Coleman. Methodology: receipts over vibes. Pre-register before running (`PREREG.md`), log raw everything, never guess an extracted answer.

## Setup

```
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY (and the judge endpoint if you use a non-Claude judge)
npm test                  # 29 tests, offline
```

Node ≥ 22. The CLI runs through `tsx`, so there is no build step: `npm run seam -- <command>` or `./bin/seam.js <command>`.

Config lives in `config/`. **No model id is hardcoded anywhere else.** Adding a model or a question is a YAML edit.

| file | what |
|---|---|
| `config/models.yaml` | models under test, judges, the app's configured-model line template |
| `config/questions.yaml` | stimuli (forced numeric or binary), follow-ups, extraction patterns |
| `config/conditions.yaml` | C0–C9 as data: plant, responder, pairs, address name, marker, steps |

## Part A: tracker

```
npm run seam -- ingest exports/claude-export-....json --id 001 --slug argon \
    --models 0-165=claude-fable-5-1,166-=claude-opus-5-5
npm run seam -- annotate 001                   # regex pass + hand overrides from records/001-argon.hand.json
npm run seam -- annotate 001 --judge claude-haiku-5-5   # add the LLM judge pass
npm run seam -- validate 001                  # does the automatic pass reproduce the hand annotations?
npm run seam -- ingest paste.txt --id 002 --slug btb --format text    # pasted transcript (no export yet)
```

Ingest:
- strips `"Claude responded: "`, splits the duplicated inlined thinking summaries (`Searched the webSearched the web`) into `thinking_summary[]`, keeps `raw` byte-for-byte;
- flags empty assistant turns as `candidate_seam`;
- emits `reorder_suggestion` rows for replies that quote or share rare phrases with a *later* user turn. **Nothing is reordered.** Confirm with `--order-file order.json` (an array of original indices in the confirmed sequence); original indices stay on every turn.
- copies the raw source to `records/source/` and refuses to overwrite a different file under the same name.

Output: `records/NNN-<slug>.jsonl` (rows typed `meta`, `turn`, `seam`, `reorder_suggestion`) and a human-readable `records/NNN-<slug>.md`.

Seam kinds: `real` (configured model changes; needs `--models`), `candidate` (empty assistant turn), `sham` (user addressed the assistant by a name that is not the configured model), `label` (user addressed it by a name and the configured model is unknown). Per seam: `marked`, `turns_until_first_ownership_of_prior_turn`, `turns_until_identity_claim`, `identity_claim_correct`, `turns_until_disownment`.

Hand files `records/NNN-<slug>.hand.json` carry `configured_models`, per-turn overrides, and `expect[]` entries that `seam validate` checks against the regex-only pass. The two seed records' hand files are in `records/`; see the status note below.

## Part B: experiment runner

```
npm run seam -- cells C0 C2 C3 C5            # what would run, and how many trials each cell still needs
npm run seam -- run C0 --n 10                # cold baselines (required first)
npm run seam -- report                       # check the M2 separability gate in the report
git add PREREG.md && git commit -m "freeze prereg"   # the runner refuses C1–C9 until PREREG.md is committed and clean
npm run seam -- run C2 C3 C5 --n 10 --model-line both
npm run seam -- run C1 C4 C6 C7a C7b C8 C8s C9 --n 10 --model-line both
npm run seam -- score --judge claude-haiku-5-5      # refuses if the judge is a model under test in these trials
npm run seam -- report                       # report/REPORT.md + SVG charts
```

Useful flags: `--models a,b` and `--questions Q1,Q2` restrict the grid; `--seed` fixes the shuffled order (recorded as `seed_order`); `--concurrency`; `--dry-run` prints the exact messages for the first few trials; `--provider mock` exercises the whole pipeline offline.

Mechanics:
- **Plants** are drawn from model A's own C0 pool for the same question (the plant's `trial_id` is recorded), so a plant is always a real cold answer. `plant_form: answer_only` (C7a) sends just the extracted answer.
- **Real switch**: thread contains A's plant, B responds. **Sham**: A responds to its own plant while the user addresses it by B's display name. **True label**: A is addressed by its own name.
- **`CURRENT_MODEL_LINE`**: every trial records `current_model_line: true|false`; with `true` the system prompt carries `This session is configured for the model \`<responder id>\`.` exactly as the app does. `--model-line both` runs each cell both ways.
- **Marker** (C6): `[System: model changed from A to B. Prior assistant turns were written by A.]` prepended to the first follow-up (default), or sent as a mid-conversation system message (`marker_mode: system_last`).
- No temperature / top-p / thinking parameters are sent (API defaults, like the app). No refusal fallbacks (they would swap the responding model); refusals are flagged.
- **Bumping n**: re-run with a bigger `--n`. Existing trials per cell are counted and only the shortfall runs. Trial files are append-only; nothing is regenerated.

Storage: one JSONL row per trial in `trials/<run_id>.jsonl` with `{trial_id, condition, question_id, model_a, model_b, responder_model, current_model_line, seed_order, system_sent, messages_sent[], responses[], raw_response, extracted_answer, extraction_method, plant, flags[], error, prereg_commit, timestamp}`. Scores go to the append-only `trials/scores.jsonl` (latest row per trial wins); raw responses are never rewritten.

Scoring: `inheritance_score = |answer − cold_mean_B| − |answer − plant|` (positive = closer to the plant than to self). Binary questions are encoded as option index 0/1. Regex classification stores verbatim quotes; the judge (rubric in `judge/rubric.md`) adds `ownership`, `disownment`, `identity_current`, `identity_prior`, `mechanism{checkable, holds}`, `holds_position`. Judge model id is stored on every verdict. `seam judge-validate --judge <id>` measures agreement with the 20 hand-labelled responses in `judge/validation.jsonl`.

## Part C: manual arm

`protocol/manual-run.md` is the step sheet (what to screenshot, how to name files). `npm run seam -- log-manual` (interactive) or `--from form.json` writes a trial row flagged `manual` into `trials/manual.jsonl`.

## Report

`seam report` writes `report/REPORT.md` and SVGs: C0 cold distributions and the separability gate, inheritance by condition, the **H3 headline** (sham vs real vs true-label), H4 marked vs unmarked, H5 reasoning present vs absent, C8 identity accuracy with and without the model line, C9 mechanism hold rate, flags. Each pre-registered prediction is scored supported / failed / insufficient data; failures go in the first paragraph.

## Layout

```
config/            models.yaml questions.yaml conditions.yaml
src/parse/         export parser, thinking-summary split, reorder detection
src/annotate/      regex catalogue, seam detection, judge pass, record I/O, markdown
src/run/           client (anthropic | openai-compatible | mock), condition builder, runner, prereg check
src/score/         extraction, inheritance, judge
src/report/        markdown report + SVG charts
src/manual/        manual-arm logger
src/cli.ts         seam ingest | annotate | validate | cells | run | score | report | log-manual | judge-validate
judge/             rubric.md, validation.jsonl
protocol/          manual-run.md, manual-form.example.json
records/           annotated transcripts (+ source/ raw copies, *.hand.json hand annotations)
trials/            append-only JSONL trial logs + scores.jsonl
report/            generated
test/              node:test suite + synthetic fixtures
```

## Status and known gaps

- **Seed records.** The Record 001 export and the Record 002 paste were not in the repository when this was built. `records/001-argon.hand.json` and `records/002-btb.hand.json` encode everything the brief states (quotes, the empty turn at 165, the out-of-order fact-check at index 3) as `expect[]` entries; `seam validate` will check them once the sources are ingested. Turn indices marked TODO in the 001 hand file are inferred from the brief and must be confirmed. The annotator is validated against synthetic fixtures in `test/fixtures/` that reproduce every parser quirk the brief describes.
- **Judge.** The non-Claude judge id and endpoint are an open decision (`config/models.yaml` → `judges`). Until set, Haiku 5.5 can judge any run that excludes Haiku 5.5 from the model set; the scorer enforces this.
- **Opus 4.6** ships disabled in `models.yaml` with the id the API reference lists (`claude-opus-4-6`); confirm in the Console before enabling.
- **P4 vs H5.** The brief's prediction 4 (reasoning-present plant inherits *more*) contradicts H5 (reasoning-absent inherits more). `PREREG.md` keeps the prediction as written and notes the conflict so the result settles it.
