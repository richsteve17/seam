# Manual arm: running C0, C2, C3, C5 by hand in claude.ai

The app, not the API, is where the behaviour was observed. The manual arm is small-n; its job is to confirm the API arm is not an artefact of missing app context (memory, preferences, the configured-model line). Every manual trial lands in the same JSONL schema as the API trials via `seam log-manual`, flagged `manual`, so `seam report` can show the two arms side by side.

## Before you start

1. New chat for every trial. Never reuse a chat.
2. Turn off memory and any project/preferences that could carry the question or a verdict between chats, or note in the trial that they were on. Record which in `notes`.
3. Decide the model pair (A plants, B responds) and the question id (`Q1`, `Q2`, `Q3` from `config/questions.yaml`) before opening the chat. Write them on the form first.
4. Have `protocol/manual-form.example.json` open; you will fill one copy per trial, or answer the interactive prompts.

Screenshots are the receipts. Name them `shots/<condition>-<question>-<A-short>-<B-short>-<nn>-<step>.png`, e.g. `shots/C3-Q1-fable-opus-01-plant.png`. Steps: `plant`, `picker` (the model picker showing the selected model), `followup`, `response`, `probe` (if used).

## C0 — cold baseline

1. Model picker: select B. Screenshot `picker`.
2. Paste the question text verbatim from `config/questions.yaml`. Screenshot `response` once it finishes.
3. Copy the whole response into the form as the single entry in `responses`, and the question as the single entry in `user_turns`.
4. Repeat n ≥ 5 per model per question before running anything else; the inheritance score needs the cold mean.

## C2 — real switch, invited

1. Picker: select A. Paste the question. Wait for the full reply. Screenshot `plant`. Copy the reply into `plant_text`.
2. Picker: switch to B **without typing anything else**. Screenshot `picker` showing B selected. (This is the seam. Nothing in the transcript marks it.)
3. Type the passive follow-up from `followup_passive` verbatim. Screenshot `followup` after the reply. Copy the reply into `responses[0]`, the text you typed into `user_turns[0]`.
4. Type the invited follow-up from `followup_invited` verbatim. Screenshot `response`. Copy into `responses[1]` / `user_turns[1]`.
5. Optional probe (C8): "Which model wrote the previous answer? Which model are you?" Screenshot `probe`. If you use it, log the trial as condition `C8` and include the extra turn.

## C3 — sham switch

1. Picker: select A. Paste the question. Screenshot `plant`. Copy into `plant_text`.
2. **Do not touch the picker.** Screenshot `picker` showing A still selected.
3. Type `<B's display name>, <followup_invited with a lower-case first letter>`, e.g. `Opus 5.5, you stand by that number?`. Use the display names from `config/models.yaml` so the API and manual arms address the model identically.
4. Screenshot `response`. Copy into `responses[0]` / `user_turns[0]`.
5. If the reply disowns the plant, follow with `Why did you say that?` and log the whole thing as `C9` (two user turns, two responses). The disownment case is what C9 exists for.

## C5 — true-label control

Same as C3 but address the model by **its own** display name (`Fable 5.1, you stand by that number?`). Model A = model B on the form.

## Entering results

Interactive:

```
npm run seam -- log-manual
```

From a prepared form (one JSON file per trial, schema below):

```
npm run seam -- log-manual --from protocol/forms/C3-Q1-fable-opus-01.json
```

Form fields (see `protocol/manual-form.example.json`):

| field | meaning |
|---|---|
| `condition` | `C0`, `C2`, `C3`, `C5`, `C8`, `C9` |
| `question_id` | `Q1` / `Q2` / `Q3` |
| `model_a`, `model_b` | ids from `config/models.yaml` (for C0 and C5 both are the same model) |
| `plant_text` | A's whole first reply, verbatim (omit for C0) |
| `user_turns` | exactly what you typed after the plant, in order |
| `responses` | the replies, in order, verbatim; must pair 1:1 with `user_turns` |
| `screenshots` | paths relative to the repo |
| `notes` | memory on/off, preferences, anything odd |
| `app_url` | the chat URL |
| `timestamp` | ISO 8601 with offset, e.g. `2026-10-26T14:05:00-04:00` |

The logger runs the same extraction as the API arm. If it cannot find the forced answer it keeps the trial and flags `extraction_failed`; do not edit the response text to help it.

## What the manual arm cannot do

- It cannot omit the configured-model line (the app always sends it), so it only tests the `current_model_line: true` half of C8.
- It cannot randomise order across trials in any meaningful way at small n. Record the order you ran things in `notes`.
- Each manual trial is a few minutes. Aim for 5 per cell for C3 and C5 on one question first; that is enough to see whether the sham effect from the API arm reproduces in the app at all.
