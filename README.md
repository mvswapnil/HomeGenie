# HomeGenie

A family household organizer for India. Family members post bills, voice notes, photos and to-dos into a shared family chat inside the app; the app turns each post into an organized, assigned item.

Product thinking lives in the **Family Household Organizer: Venture Workbook** (market report, MVP scope, data model, screens). This repo builds it.

## Status

| Milestone | State |
| --- | --- |
| 1. Parser + eval harness | ✅ Done: parser, 80 unit tests, 40-message scorecard |
| 2. Backend core (Supabase: auth, households, items, reminders) | Schema written and tested; API not started |
| 3. Chat + real-time | Not started |
| 4. Mobile app (Expo) | Not started |

## Layout

```
packages/
  shared/            Domain types shared by parser, backend and app (mirror the SQL schema)
  parser/
    src/
      chatter.ts         Cheap screen: "ok", "on my way", emoji never cost a model call
      extractors/
        anthropic.ts     Claude, forced to one tool call, output validated with zod
        heuristic.ts     Rule-based baseline and fallback when the API is down
        prompt.ts        The extraction prompt
      resolve/
        dates.ts         Hinglish date words → timestamps (kal, parso, 5 tareekh, har mahine...)
        members.ts       Who an item belongs to (@mention > name > "me" > sender)
      pipeline.ts        chatter → extract → resolve → decide (item / suggestion / none), bill dedupe
    eval/
      dataset.jsonl      40 synthetic test messages with expected results
      run.ts             The scorecard
    test/                Unit tests
supabase/
  migrations/0001_init.sql   Tables, indexes, row-level security, real-time
```

## Quick start

```bash
npm install
npm test                 # unit tests
npm run build            # typecheck + compile
npm run eval             # scorecard with the rule-based baseline (no API key needed)
```

With an Anthropic API key:

```bash
cp .env.example .env     # add ANTHROPIC_API_KEY
export $(cat .env | xargs)
npm run eval -- --extractor claude
npm run eval -- --extractor claude --only task --verbose
```

`PARSER_MODEL` picks the model (default `claude-haiku-4-5-20251001`). Compare models on real messages before choosing.

## The one rule

**The model proposes; code decides.** The extractor only classifies and *quotes* ("kal shaam", "papa"). Deterministic code turns those words into timestamps and member ids, and decides whether to write an item, show a "Make this a task?" suggestion, or do nothing. That keeps dates correct, makes behaviour testable, and lets us swap models freely.

Decision rule (`pipeline.ts`): any item below 0.8 confidence, or with a guessed date ("next week", "after Diwali"), becomes a suggestion. Otherwise items are written directly with an Undo.

## Scorecard

The MVP bar is **85% of messages fully correct**: right decision, right number of items, and every checked field right (type, assignee, due date, time, amount, list, recurrence). Titles aren't scored yet.

Current results on the synthetic set:

| Extractor | Fully correct |
| --- | --- |
| heuristic (rules) | 34/40 = 85.0% |
| claude (`claude-haiku-4-5-20251001`) | 37/40 = 92.5% on first run; 40/40 on two runs after the fixes in PR #1 |

The 40/40 came after fixing the exact cases Claude missed, so it overstates real-world accuracy. A full run takes about 50 seconds.

Treat the synthetic score with suspicion: the same person wrote the test messages and the rules. **The real test is the concierge week.** Collect ~200 real family messages and add them to a new file in the same format:

```json
{"id":"real-001","sender":"mom","text":"bijli ka bill 2180, 8 tareekh","expect":{"decision":"items","items":[{"type":"bill","assignee":"mom","due":"2026-10-08","amount":2180}]}}
```

Then `npm run eval -- --data path/to/real.jsonl --extractor claude`. Dates are scored against a fixed clock: Wednesday 30 Sep 2026, 10:00 IST. Member ids: `mom`, `papa`, `riya`, `arjun`, `dadi`.

## Decisions made while building

- **Default assignee.** The workbook said both "default is the sender" (MVP tab) and "otherwise unassigned" (data model tab). Code does: no one named → **the sender**, except shopping-list entries, which stay **shared**. "Someone / koi / sab" → shared.
- **"4 baje" means 4 pm.** A bare hour from 1 to 6 with no "subah" or am/pm is read as afternoon.
- **Festivals have no date.** "After Diwali" becomes a suggestion with the date left open, rather than a hard-coded festival calendar that could be wrong.
- **Dates a few days past** ("pay by 28 Sep" sent on 30 Sep) are read as overdue, not as next year.

## Next up

1. Run the Claude extractor on real concierge messages (the synthetic set is now saturated).
2. Voice: benchmark speech-to-text on real Hinglish voice notes (fills `chat_message.transcript`).
3. Backend: Supabase project, phone OTP, a parse worker that picks up `pending` messages and writes items, suggestions and `item_event` rows.
