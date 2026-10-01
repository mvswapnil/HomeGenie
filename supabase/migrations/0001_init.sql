-- Ghar: initial schema.
-- Mirrors packages/shared/src/index.ts. Written for Supabase (Postgres 15+, auth.users).
-- Every table carries household_id, and row-level security limits each user to their own household.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Households and members
-- ---------------------------------------------------------------------------

create table household (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  tz          text not null default 'Asia/Kolkata',
  plan        text not null default 'free' check (plan in ('free', 'family', 'family_plus')),
  invite_code text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  created_at  timestamptz not null default now()
);

create table member (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  user_id       uuid unique references auth.users(id) on delete set null,  -- phone OTP login
  display_name  text not null,
  aliases       text[] not null default '{}',          -- 'papa', 'mummy', 'riya', stored lower-case
  wa_phone      text unique,                             -- only for the later WhatsApp fallback
  role          text not null default 'adult' check (role in ('owner', 'adult', 'kid')),
  push_token    text,
  locale        text not null default 'en-IN',
  joined_at     timestamptz not null default now()
);
create index member_household_idx on member (household_id);

-- MVP: one household per account (see Data model tab, edge cases).

-- ---------------------------------------------------------------------------
-- Chat: the capture log
-- ---------------------------------------------------------------------------

create table chat_message (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references household(id) on delete cascade,
  sender_member_id  uuid not null references member(id),
  client_msg_id     text not null,                       -- idempotency key from the device
  channel           text not null default 'app' check (channel in ('app', 'share_sheet', 'whatsapp')),
  kind              text not null default 'text' check (kind in ('text', 'voice', 'image', 'document')),
  body_text         text,
  media_url         text,
  transcript        text,                                -- speech-to-text or OCR, filled before parsing
  reply_to_id       uuid references chat_message(id),
  mentions          uuid[] not null default '{}',        -- member ids from @mention autocomplete
  created_at        timestamptz not null default now(),
  parse_status      text not null default 'pending'
                      check (parse_status in ('pending', 'item', 'suggested', 'none', 'failed')),
  unique (household_id, client_msg_id)
);
create index chat_message_household_time_idx on chat_message (household_id, created_at desc);
create index chat_message_pending_idx on chat_message (parse_status) where parse_status = 'pending';

-- "Make this a task?" cards
create table suggestion (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references chat_message(id) on delete cascade,
  proposed    jsonb not null,                            -- ResolvedItem[]
  state       text not null default 'shown' check (state in ('shown', 'accepted', 'dismissed')),
  decided_by  uuid references member(id),
  decided_at  timestamptz
);
create index suggestion_message_idx on suggestion (message_id);

-- ---------------------------------------------------------------------------
-- Lists and items
-- ---------------------------------------------------------------------------

create table list (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  name          text not null,
  kind          text not null default 'custom' check (kind in ('shopping', 'packing', 'custom')),
  unique (household_id, name)
);

create table item (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references household(id) on delete cascade,
  type               text not null check (type in ('task', 'list_entry', 'bill', 'reminder')),
  title              text not null,
  notes              text,
  status             text not null default 'open' check (status in ('open', 'done', 'snoozed', 'cancelled')),
  created_by         uuid not null references member(id),
  assigned_to        uuid references member(id),
  list_id            uuid references list(id) on delete set null,
  due_at             timestamptz,
  recurrence_rule    text,                               -- RFC 5545 RRULE
  attrs              jsonb not null default '{}',        -- bill: {amount, currency, biller, accountRef, paidVia}
  source_message_id  uuid references chat_message(id),
  parse_confidence   real,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,
  check (type <> 'list_entry' or list_id is not null)
);
create index item_household_open_idx on item (household_id, status, due_at);
create index item_assignee_idx on item (assigned_to) where status = 'open';
create index item_source_idx on item (source_message_id);

-- Dedupe support: same bill sent twice by two members (biller + amount + due date within 7 days)
create index item_bill_dedupe_idx on item (household_id, (attrs->>'biller'), (attrs->>'amount'), due_at)
  where type = 'bill';

create table reminder_schedule (
  id        uuid primary key default gen_random_uuid(),
  item_id   uuid not null references item(id) on delete cascade,
  fire_at   timestamptz not null,
  channel   text not null default 'push' check (channel in ('push', 'whatsapp')),
  sent_at   timestamptz,
  ack_at    timestamptz
);
create index reminder_due_idx on reminder_schedule (fire_at) where sent_at is null;

-- Audit trail: drives undo, the activity feed and parse-accuracy metrics
create table item_event (
  id               uuid primary key default gen_random_uuid(),
  item_id          uuid not null references item(id) on delete cascade,
  actor_member_id  uuid references member(id),           -- null = the parser
  action           text not null check (action in ('created', 'edited', 'done', 'reopened', 'snoozed', 'undone', 'assigned')),
  diff             jsonb not null default '{}',
  at               timestamptz not null default now()
);
create index item_event_item_idx on item_event (item_id, at);

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger item_touch before update on item for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security: a signed-in user sees only their own household
-- ---------------------------------------------------------------------------

create or replace function my_household_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select household_id from member where user_id = auth.uid()
$$;

alter table household         enable row level security;
alter table member            enable row level security;
alter table chat_message      enable row level security;
alter table suggestion        enable row level security;
alter table list              enable row level security;
alter table item              enable row level security;
alter table reminder_schedule enable row level security;
alter table item_event        enable row level security;

create policy household_rw on household for all
  using (id = my_household_id()) with check (id = my_household_id());

create policy member_rw on member for all
  using (household_id = my_household_id()) with check (household_id = my_household_id());

-- Members read the whole family chat but can only post as themselves.
create policy chat_read on chat_message for select using (household_id = my_household_id());
create policy chat_insert on chat_message for insert with check (
  household_id = my_household_id()
  and sender_member_id = (select id from member where user_id = auth.uid())
);

create policy suggestion_rw on suggestion for all using (
  exists (select 1 from chat_message m where m.id = message_id and m.household_id = my_household_id())
);

create policy list_rw on list for all
  using (household_id = my_household_id()) with check (household_id = my_household_id());

create policy item_rw on item for all
  using (household_id = my_household_id()) with check (household_id = my_household_id());

create policy reminder_rw on reminder_schedule for all using (
  exists (select 1 from item i where i.id = item_id and i.household_id = my_household_id())
);

create policy item_event_read on item_event for select using (
  exists (select 1 from item i where i.id = item_id and i.household_id = my_household_id())
);
-- item_event rows are written by the server (service role), never directly by clients.

-- Real-time: the app subscribes to these for the chat and the dashboard.
alter publication supabase_realtime add table chat_message, item, suggestion;
