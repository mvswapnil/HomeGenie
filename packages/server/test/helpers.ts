/**
 * Test support: a fresh Postgres database per test file, with the Supabase stand-ins and every
 * migration applied, plus a scripted extractor so tests don't call a model.
 *
 * Point TEST_DATABASE_URL at any Postgres you can create databases on, e.g.
 *   postgres://postgres:postgres@localhost:5432/postgres
 * If none is reachable, the database tests are skipped (the unit tests still run).
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { SignJWT } from "jose";
import type { ExtractionInput, Extractor, ExtractInput } from "@homegenie/parser";
import { createPool, type Db } from "../src/db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/postgres";
export const JWT_SECRET = "test-secret-at-least-32-characters-long!!";

export async function postgresAvailable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export interface TestDb {
  db: Db;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `hg_test_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = urlFor(name);
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  await setup.query("set client_min_messages = error");
  await setup.query(readFileSync(join(ROOT, "supabase/local/supabase_stub.sql"), "utf8"));
  const dir = join(ROOT, "supabase/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await setup.query(readFileSync(join(dir, f), "utf8"));
  }
  await setup.end();

  const db = createPool(url);
  return {
    db,
    url,
    async drop() {
      await db.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

/** The Sharma household from the workbook mockups. Fixed ids keep assertions readable. */
export const H = "aaaaaaaa-0000-4000-8000-000000000001";
export const OTHER_H = "bbbbbbbb-0000-4000-8000-000000000002";
export const M = {
  mom: "a0000000-0000-4000-8000-000000000001",
  papa: "a0000000-0000-4000-8000-000000000002",
  riya: "a0000000-0000-4000-8000-000000000003",
  arjun: "a0000000-0000-4000-8000-000000000004",
  stranger: "b0000000-0000-4000-8000-000000000001",
} as const;
export const U = {
  mom: "11111111-0000-4000-8000-000000000001",
  papa: "11111111-0000-4000-8000-000000000002",
  stranger: "22222222-0000-4000-8000-000000000001",
  nobody: "33333333-0000-4000-8000-000000000001",
} as const;

export async function seed(db: Db) {
  await db.query(`insert into auth.users (id) values ($1), ($2), ($3), ($4)`, [U.mom, U.papa, U.stranger, U.nobody]);
  await db.query(`insert into household (id, name) values ($1, 'Sharma'), ($2, 'Iyer')`, [H, OTHER_H]);
  await db.query(
    `insert into member (id, household_id, user_id, display_name, aliases, role) values
      ($1, $6, $8, 'Mom', '{mom,mummy}', 'owner'),
      ($2, $6, $9, 'Papa', '{papa,dad}', 'adult'),
      ($3, $6, null, 'Riya', '{riya}', 'kid'),
      ($4, $6, null, 'Arjun', '{arjun,bhaiya}', 'adult'),
      ($5, $7, $10, 'Anil', '{anil}', 'owner')`,
    [M.mom, M.papa, M.riya, M.arjun, M.stranger, H, OTHER_H, U.mom, U.papa, U.stranger],
  );
  await db.query(`insert into list (household_id, name, kind) values ($1, 'Shopping', 'shopping')`, [H]);
}

let seq = 0;
/** Insert a chat message. `at` defaults to Wed 30 Sep 2026 10:00 IST plus a minute per message. */
export async function postMessage(
  db: Db,
  from: string,
  text: string,
  opts: { householdId?: string; at?: string; replyTo?: string; mentions?: string[] } = {},
): Promise<string> {
  seq++;
  const at = opts.at ?? new Date(Date.parse("2026-09-30T04:30:00Z") + seq * 60_000).toISOString();
  const { rows } = await db.query(
    `insert into chat_message (household_id, sender_member_id, client_msg_id, body_text, created_at, reply_to_id, mentions)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [opts.householdId ?? H, from, `c${seq}-${Math.random()}`, text, at, opts.replyTo ?? null, opts.mentions ?? []],
  );
  return rows[0].id;
}

/** Extractor that answers from a script keyed by message text, and records what it was shown. */
export function scripted(script: Record<string, ExtractionInput | Error>): Extractor & { calls: ExtractInput[] } {
  const calls: ExtractInput[] = [];
  return {
    name: "scripted",
    calls,
    async extract(input) {
      calls.push(input);
      const answer = script[input.text];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error(`no scripted answer for: ${input.text}`);
      // Refs are positional; let scripts name items by title instead ("@Pay electricity bill").
      return {
        ...answer,
        updates: (answer.updates ?? []).map((u) => {
          if (!u.ref.startsWith("@")) return u;
          const hit = input.context?.openItems.find((i) => i.title === u.ref.slice(1));
          return { ...u, ref: hit?.ref ?? "missing" };
        }),
      };
    },
  };
}

export const item = (over: Partial<ExtractionInput["items"][number]>): ExtractionInput["items"][number] => ({
  type: "task",
  title: "Task",
  assignee_hint: null,
  due_text: null,
  amount: null,
  list_name: null,
  biller: null,
  confidence: 0.95,
  ...over,
});

export async function tokenFor(userId: string): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}
