/**
 * The small HTTP API for actions that must go through server logic (events, reminders, learning).
 * Everything else, such as reading the chat and items or posting a message, goes straight to
 * Supabase from the app, guarded by row-level security.
 */
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Member, ResolvedItem } from "@homegenie/shared";
import { withTx, type Db } from "./db.js";
import { getHousehold, getMemberByUser } from "./repo.js";
import { createItems, editItem, undoLastChange, undoMessage } from "./items.js";

export interface AuthConfig {
  /** Legacy Supabase projects sign JWTs with a shared secret (HS256). */
  jwtSecret?: string;
  /** Newer projects publish signing keys: https://<project>.supabase.co/auth/v1/.well-known/jwks.json */
  jwksUrl?: string;
}

type Env = { Variables: { member: Member; tz: string } };

export function createApi(db: Db, auth: AuthConfig, clock: () => Date = () => new Date()) {
  const app = new Hono<Env>();
  const jwks: JWTVerifyGetKey | null = auth.jwksUrl ? createRemoteJWKSet(new URL(auth.jwksUrl)) : null;
  const secret = auth.jwtSecret ? new TextEncoder().encode(auth.jwtSecret) : null;
  if (!jwks && !secret) throw new Error("API needs SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL");

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return c.json({ error: "missing token" }, 401);
    let sub: string | undefined;
    try {
      const { payload } = jwks ? await jwtVerify(token, jwks) : await jwtVerify(token, secret!);
      sub = payload.sub;
    } catch {
      return c.json({ error: "invalid token" }, 401);
    }
    const member = sub ? await getMemberByUser(db, sub) : null;
    if (!member) return c.json({ error: "not in a household" }, 403);
    c.set("member", member);
    c.set("tz", (await getHousehold(db, member.householdId)).tz);
    await next();
  });

  const ctx = (c: { get: (k: "member" | "tz") => any }) => {
    const member = c.get("member") as Member;
    return { householdId: member.householdId, actor: member.id, tz: c.get("tz") as string, now: clock() };
  };

  /** "Make this a task?" → Add. Creates the proposed items on behalf of the original sender. */
  app.post("/v1/suggestions/:id/accept", async (c) => {
    const a = ctx(c);
    const out = await withTx(db, async (tx) => {
      const { rows } = await tx.query(
        `select s.*, m.sender_member_id, m.household_id from suggestion s join chat_message m on m.id = s.message_id
         where s.id = $1 and m.household_id = $2 for update of s`,
        [c.req.param("id"), a.householdId],
      );
      const s = rows[0];
      if (!s) return { status: 404 as const, body: { error: "not found" } };
      if (s.state !== "shown") return { status: 409 as const, body: { error: `already ${s.state}` } };
      const created = await createItems(tx, s.proposed as ResolvedItem[], { ...a, createdBy: s.sender_member_id, messageId: s.message_id, actor: a.actor });
      await tx.query("update suggestion set state = 'accepted', decided_by = $2, decided_at = now(), item_ids = $3 where id = $1", [s.id, a.actor, created.itemIds]);
      await tx.query(
        `update chat_message set parse_status = 'item',
           parse_result = coalesce(parse_result, '{}'::jsonb) || jsonb_build_object('itemIds', $2::jsonb, 'duplicates', $3::jsonb)
         where id = $1`,
        [s.message_id, JSON.stringify(created.itemIds), JSON.stringify(created.duplicates)],
      );
      return { status: 200 as const, body: created };
    });
    return c.json(out.body, out.status);
  });

  app.post("/v1/suggestions/:id/dismiss", async (c) => {
    const a = ctx(c);
    const { rowCount } = await db.query(
      `update suggestion s set state = 'dismissed', decided_by = $2, decided_at = now()
       from chat_message m where m.id = s.message_id and s.id = $1 and m.household_id = $3 and s.state = 'shown'`,
      [c.req.param("id"), a.actor, a.householdId],
    );
    return rowCount ? c.json({ ok: true }) : c.json({ error: "not found or already decided" }, 404);
  });

  /** The Undo on a chat card: reverses everything that message did. */
  app.post("/v1/messages/:id/undo", async (c) => {
    const a = ctx(c);
    const itemIds = await withTx(db, (tx) => undoMessage(tx, c.req.param("id"), a));
    return c.json({ itemIds });
  });

  app.post("/v1/items/:id/undo", async (c) => {
    const a = ctx(c);
    const ok = await withTx(db, (tx) => undoLastChange(tx, c.req.param("id"), a));
    return ok ? c.json({ ok: true }) : c.json({ error: "nothing to undo" }, 404);
  });

  const Patch = z
    .object({
      title: z.string().min(1).max(200),
      type: z.enum(["task", "list_entry", "bill", "reminder"]),
      assignedTo: z.string().uuid().nullable(),
      dueAt: z.string().datetime({ offset: true }).nullable(),
      amount: z.number().positive().nullable(),
      status: z.enum(["open", "done", "snoozed", "cancelled"]),
    })
    .partial()
    .strict();

  /** Edit or tick off an item. Edits within a day of creation teach the parser. */
  app.patch("/v1/items/:id", async (c) => {
    const a = ctx(c);
    const parsed = Patch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    if (parsed.data.assignedTo) {
      const ok = await db.query("select 1 from member where id = $1 and household_id = $2", [parsed.data.assignedTo, a.householdId]);
      if (!ok.rowCount) return c.json({ error: "assignee is not in this household" }, 400);
    }
    const item = await withTx(db, (tx) => editItem(tx, c.req.param("id"), parsed.data, a));
    return item ? c.json(item) : c.json({ error: "not found" }, 404);
  });

  app.post("/v1/members/me/push-token", async (c) => {
    const body = z.object({ token: z.string().min(10).max(300) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    await db.query("update member set push_token = $2 where id = $1", [c.get("member").id, body.data.token]);
    return c.json({ ok: true });
  });

  return app;
}
