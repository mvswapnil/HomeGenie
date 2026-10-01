/**
 * The parse worker: turns new chat messages into items, suggestions and updates.
 *
 * Per household, messages are handled strictly in order, one at a time, so a correction
 * ("actually ₹4,500") never runs before the message it corrects. Across households it runs in
 * parallel. Claims use SKIP LOCKED, so several worker processes can share the queue.
 */
import pg from "pg";
import { parseMessage, type Extractor } from "@homegenie/parser";
import type { MessageParseResult } from "@homegenie/shared";
import { withTx, type Db } from "./db.js";
import { getHousehold, getListNames, getMembers, messageText, toMessage } from "./repo.js";
import { buildContext, parseSuggestionRef } from "./context.js";
import { applySuggestionUpdate, applyUpdate, createItems } from "./items.js";
import { sendDueReminders, logPushSender, type PushSender } from "./reminders.js";

export const MAX_ATTEMPTS = 3;
/** A claim older than this is assumed to belong to a crashed worker and is taken over. */
export const STALE_CLAIM_SECONDS = 120;

export interface WorkerDeps {
  db: Db;
  extractor: Extractor;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Claim the next message whose household has nothing older pending and nothing in flight. */
export async function claimNext(db: Db): Promise<string | null> {
  const { rows } = await db.query(
    `update chat_message set parse_status = 'processing', parse_claimed_at = now(), parse_attempts = parse_attempts + 1
     where id = (
       select m.id from chat_message m
       where (m.parse_status = 'pending'
              or (m.parse_status = 'processing' and m.parse_claimed_at < now() - make_interval(secs => $1)))
         and not exists (select 1 from chat_message o where o.household_id = m.household_id and o.created_at < m.created_at
                         and (o.parse_status = 'pending'
                              or (o.parse_status = 'processing' and o.parse_claimed_at >= now() - make_interval(secs => $1))))
         and not exists (select 1 from chat_message p where p.household_id = m.household_id and p.id <> m.id
                         and p.parse_status = 'processing' and p.parse_claimed_at >= now() - make_interval(secs => $1))
       order by m.created_at
       limit 1
       for update skip locked)
     returning id`,
    [STALE_CLAIM_SECONDS],
  );
  return rows[0]?.id ?? null;
}

/** Parse one claimed message and write the outcome. Never throws: failures are recorded on the row. */
export async function processMessage(deps: WorkerDeps, messageId: string): Promise<MessageParseResult | null> {
  const now = (deps.now ?? (() => new Date()))();
  const { db, extractor } = deps;
  try {
    const msg = toMessage((await db.query("select * from chat_message where id = $1", [messageId])).rows[0]);
    const household = await getHousehold(db, msg.householdId);
    const members = await getMembers(db, msg.householdId);
    const text = messageText(msg);

    if (!text) {
      const result: MessageParseResult = { itemIds: [], suggestionId: null, updatedItemIds: [], duplicates: [], reason: "no text yet (voice and photo transcription not built)" };
      await finish(db, messageId, "none", result);
      return result;
    }

    // Reads and the model call happen outside the transaction; only the writes are atomic.
    const { context, itemRefs } = await buildContext(db, msg, members, household.tz, now);
    const parsed = await parseMessage(
      { text, senderId: msg.senderMemberId, mentions: msg.mentions, members, listNames: await getListNames(db, msg.householdId), tz: household.tz, now: new Date(msg.createdAt), context, itemRefs },
      extractor,
    );

    return await withTx(db, async (tx) => {
      const result: MessageParseResult = { itemIds: [], suggestionId: null, updatedItemIds: [], duplicates: [] };
      const base = { householdId: msg.householdId, tz: household.tz, now };

      for (const u of parsed.updates) {
        const args = { ...base, actor: msg.senderMemberId, messageId };
        const sref = parseSuggestionRef(u.itemId);
        if (sref) {
          result.updatedItemIds.push(...(await applySuggestionUpdate(tx, sref, u, args)));
          continue;
        }
        const id = await applyUpdate(tx, u, args);
        if (id) result.updatedItemIds.push(id);
      }

      const d = parsed.decision;
      if (d.kind === "items") {
        const created = await createItems(tx, d.items, { ...base, createdBy: msg.senderMemberId, messageId });
        result.itemIds = created.itemIds;
        result.duplicates = created.duplicates;
      } else if (d.kind === "suggestion") {
        const { rows } = await tx.query("insert into suggestion (message_id, proposed) values ($1, $2) returning id", [messageId, JSON.stringify(d.items)]);
        result.suggestionId = rows[0].id;
      } else {
        result.reason = d.reason;
      }

      const status = result.itemIds.length || result.updatedItemIds.length ? "item" : result.suggestionId ? "suggested" : "none";
      await finish(tx, messageId, status, result);
      return result;
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    deps.log?.(`parse failed for ${messageId}: ${message}`);
    await db.query(
      `update chat_message set parse_status = case when parse_attempts >= $2 then 'failed' else 'pending' end,
              parse_error = $3, parse_claimed_at = null where id = $1`,
      [messageId, MAX_ATTEMPTS, message.slice(0, 500)],
    );
    return null;
  }
}

async function finish(q: Pick<Db, "query"> | pg.PoolClient, id: string, status: string, result: MessageParseResult) {
  await q.query(
    "update chat_message set parse_status = $2, parse_result = $3, parsed_at = now(), parse_error = null, parse_claimed_at = null where id = $1",
    [id, status, JSON.stringify(result)],
  );
}

/** Drain the queue once. Returns how many messages were handled. */
export async function runOnce(deps: WorkerDeps, max = 100): Promise<number> {
  let n = 0;
  while (n < max) {
    const id = await claimNext(deps.db);
    if (!id) break;
    await processMessage(deps, id);
    n++;
  }
  return n;
}

export interface RunningWorker {
  stop(): Promise<void>;
}

/**
 * Long-running loop: wakes on LISTEN/NOTIFY when a message is inserted, and polls every
 * few seconds anyway (notifications are lost if the connection drops). Also sends due reminders.
 */
export async function startWorker(deps: WorkerDeps & { connectionString: string; push?: PushSender; pollMs?: number }): Promise<RunningWorker> {
  const log = deps.log ?? console.log;
  const listener = new pg.Client({ connectionString: deps.connectionString });
  await listener.connect();
  let stopped = false;
  let busy = false;
  let again = false;

  const tick = async () => {
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        const n = await runOnce(deps);
        if (n) log(`parsed ${n} message(s)`);
        await sendDueReminders(deps.db, deps.push ?? logPushSender, (deps.now ?? (() => new Date()))());
      } while (again && !stopped);
    } catch (err) {
      log(`worker error: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };

  listener.on("notification", () => void tick());
  await listener.query("listen chat_message_pending");
  const timer = setInterval(() => void tick(), deps.pollMs ?? 3000);
  void tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await listener.end().catch(() => {});
      while (busy) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
