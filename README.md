# HomeGenie

A family household organizer for India. Family members post bills, voice notes, photos and to-dos into a shared family chat inside the app; the app turns each post into an organized, assigned item.

Product thinking lives in the **Family Household Organizer: Venture Workbook** (market report, MVP scope, data model, screens). This repo builds it.

## Status

| Milestone | State |
| --- | --- |
| 1. Parser + eval harness | ✅ Done |
| 2. Backend core | ✅ Done: parse worker, conversation context, household memory, reminders, API, household setup. Runs on plain Postgres; not yet deployed to a Supabase project |
| 3. Voice notes and photos (speech-to-text, bill images) | Not started |
| 4. Mobile app (Expo) | Not started |

## How a message flows

```
app inserts chat_message (Supabase, row-level security)
   │  trigger: pg_notify('chat_message_pending')
   ▼
worker claims it (one at a time per household, in order; SKIP LOCKED across processes)
   │  builds context: last 10 messages · open items as refs i1, i2… · pending suggestions as s1, s2…
   │                  · household memory · recent corrections the family made
   ▼
parser: chatter screen → Claude (quotes words, picks refs) → code resolves dates, people, refs
   ▼
one transaction:
   new items (+ item_event, reminders, memory)  ·  "Make this a task?" suggestion
   updates to existing items: edit · complete · cancel · claim
   follow-ups to a suggestion: firm it up → auto-saved, or "rehne do" → dismissed
   chat_message.parse_result → the cards the app draws under the message
```

Example from a live run (real Claude, real Postgres):

| Message | What happened |
| --- | --- |
| Mom: "Electricity bill ₹4,237 pay by 1st of next month" | Bill created, due 1 Nov, reminder scheduled |
| Mom: "sorry, it's ₹4,512 actually" | Same bill updated to ₹4,512 |
| Papa (reply): "main bhar dunga" | Bill assigned to Papa |
| Riya: "ok 👍" | Ignored, no model call |
| Arjun: "AC thoda kharab lag raha hai" | "Make this a task?" suggestion |
| Papa: "bijli ka bill bhar diya, aur aate waqt doodh le aana Arjun" | Bill marked paid (memory: Papa paid it) and Milk added to Shopping for Arjun |

Reproduce it with `packages/server/scripts/live-smoke.ts` (see below).

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
        prompt.ts        The extraction prompt, including context and update rules
      resolve/
        dates.ts         Hinglish date words → timestamps (kal, parso, 5 tareekh, har mahine...)
        members.ts       Who an item belongs to (@mention > name > "me" > sender)
      pipeline.ts        chatter → extract → resolve → decide; item updates; bill dedupe
    eval/                40 synthetic test messages and the scorecard
  server/
    src/
      worker.ts          Parse queue: claim, build context, parse, write; retries; reminder sending
      context.ts         What the parser sees besides the message
      items.ts           Every item write: events, undo, suggestion follow-ups, repeats
      memory.ts          Household memory: bill amounts, due days, who usually pays; corrections
      reminders.ts       Reminder timing, quiet hours, next occurrence of repeating items
      api.ts             HTTP API (Supabase JWT auth)
      index.ts           Runs worker + API
    scripts/live-smoke.ts  End-to-end run with real Claude
    test/                Integration tests (real Postgres) and unit tests
supabase/
  migrations/        0001 tables + row-level security · 0002 memory, parse queue, household setup
  local/             Stand-ins for Supabase's auth schema, for plain Postgres only
```

## Quick start

```bash
npm install
npm test                 # unit tests; database tests run too if Postgres is reachable (below)
npm run build            # typecheck + compile all packages
npm run eval             # parser scorecard with the rule-based baseline (no API key needed)
```

### Database tests

Any Postgres 15+ you can create databases on. Each test file makes its own throwaway database.

```bash
docker run -d --name hg-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
npm test
```

### Running the server

```bash
export DATABASE_URL=postgres://...          # Supabase: the direct connection string
export SUPABASE_JWT_SECRET=...              # or SUPABASE_JWKS_URL for newer projects
export ANTHROPIC_API_KEY=sk-ant-...         # optional; without it the rule-based parser runs
npm run build && npm start -w @homegenie/server
```

For plain Postgres, apply `supabase/local/supabase_stub.sql` and then the migrations in order. On Supabase, apply only the migrations.

### Live end-to-end check

```bash
TEST_DATABASE_URL=... ANTHROPIC_API_KEY=... npx tsx packages/server/scripts/live-smoke.ts
```

## API

The app reads chat, items and lists, and posts messages, directly through Supabase (row-level security limits each member to their household). Actions that need server logic go through the API, with the user's Supabase token as `Authorization: Bearer …`:

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/v1/suggestions/:id/accept` | "Add" on a suggestion card |
| POST | `/v1/suggestions/:id/dismiss` | Dismiss a suggestion card |
| POST | `/v1/messages/:id/undo` | Undo on a chat card: reverses everything that message did |
| POST | `/v1/items/:id/undo` | Reverse an item's latest change |
| PATCH | `/v1/items/:id` | Edit or tick off: `title`, `type`, `assignedTo`, `dueAt`, `amount`, `status` |
| POST | `/v1/members/me/push-token` | Register the device for reminders |

Household setup is in the database, callable as Supabase RPC: `create_household(name, display_name)`, `join_household(invite_code, display_name)`, `set_my_aliases(aliases)`.

## The one rule

**The model proposes; code decides.** The extractor only classifies, *quotes* ("kal shaam", "papa") and points at refs ("i3"). Code turns words into timestamps and member ids, checks every ref against what it offered, and decides what to write. Item ids never reach the model.

- Any new item below 0.8 confidence, or with a guessed date, becomes a suggestion; otherwise it's saved with an Undo.
- Updates below 0.8 confidence are dropped. A vague new date never overwrites a real one.
- Every change is an `item_event`, so any message's effect can be undone.

## Scorecard

The bar is **85% of messages fully correct**: right decision, right number of items, and every checked field right. Titles aren't scored yet.

| Extractor | Fully correct |
| --- | --- |
| heuristic (rules) | 34/40 = 85.0% |
| claude (`claude-haiku-4-5-20251001`) | 40/40 on two runs (37/40 before PR #1) |

The synthetic set is saturated and was written by the same person who tuned the prompt, so it overstates real accuracy. **The real test is the concierge week.** Add real messages in the same format:

```json
{"id":"real-001","sender":"mom","text":"bijli ka bill 2180, 8 tareekh","expect":{"decision":"items","items":[{"type":"bill","assignee":"mom","due":"2026-10-08","amount":2180}]}}
```

Then `npm run eval -- --data path/to/real.jsonl --extractor claude`. Dates are scored against a fixed clock: Wednesday 30 Sep 2026, 10:00 IST. Member ids: `mom`, `papa`, `riya`, `arjun`, `dadi`. The scorecard covers single messages; conversation behaviour is covered by the server integration tests and the live check.

## Decisions made while building

- **Default assignee.** No one named → **the sender**, except shopping-list entries, which stay **shared**. "Someone / koi / sab" → shared. Once a bill has been paid twice by the same person, new copies of it go to them.
- **"4 baje" means 4 pm.** A bare hour from 1 to 6 with no "subah" or am/pm is read as afternoon.
- **Festivals have no date.** "After Diwali" becomes a suggestion with the date left open.
- **Dates a few days past** ("pay by 28 Sep" sent on 30 Sep) are read as overdue, not as next year.
- **Relative dates are read against the message's time,** not the time the worker processes it.
- **One message at a time per household,** so a correction never runs before the message it corrects.
- **Replies skip the chatter screen,** so a bare "ok" or "done" in reply to a task can settle it.
- **Voice and photos** are stored but not parsed until transcription exists; they're marked "no text yet".

## Next up

1. Concierge week: real messages into the scorecard.
2. A Supabase project: apply migrations, turn on phone OTP, deploy the server (any Node host).
3. Voice and photos: speech-to-text for Hinglish voice notes; send bill photos straight to Claude.
4. The Expo app: chat tab first.
