-- HomeGenie 0002: household memory, the parse queue, and household setup functions.

-- ---------------------------------------------------------------------------
-- Household memory: what the family has taught the app
-- ---------------------------------------------------------------------------
-- One row per thing learned, keyed so it is updated in place rather than piling up.
--   kind 'biller'  key = normalised biller ('electricity')  value = {label, usualAmount, dueDay, paidBy, count}
--   kind 'note'    key = free text slug                     value = {text}   (stated by a member, later)
create table household_fact (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  kind          text not null check (kind in ('biller', 'note')),
  key           text not null,
  value         jsonb not null default '{}',
  source        text not null default 'learned' check (source in ('learned', 'stated', 'correction')),
  hits          int not null default 1,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (household_id, kind, key)
);

alter table household_fact enable row level security;
create policy household_fact_read on household_fact for select using (household_id = my_household_id());
-- Written by the server only.

-- ---------------------------------------------------------------------------
-- Parse queue on chat_message
-- ---------------------------------------------------------------------------
alter table chat_message drop constraint chat_message_parse_status_check;
alter table chat_message add constraint chat_message_parse_status_check
  check (parse_status in ('pending', 'processing', 'item', 'suggested', 'none', 'failed'));
alter table chat_message
  add column parse_attempts int not null default 0,
  add column parse_claimed_at timestamptz,
  add column parsed_at timestamptz,
  add column parse_error text,
  -- What the parser did, for the chat cards: {itemIds, suggestionId, updatedItemIds, duplicates: [{itemId, addedBy}]}
  add column parse_result jsonb;

drop index chat_message_pending_idx;
create index chat_message_queue_idx on chat_message (created_at) where parse_status in ('pending', 'processing');

-- Wake the worker the moment a message lands (it also polls, in case a notification is missed).
create or replace function notify_chat_message() returns trigger language plpgsql as $$
begin
  perform pg_notify('chat_message_pending', new.id::text);
  return new;
end $$;
create trigger chat_message_notify after insert on chat_message for each row execute function notify_chat_message();

-- ---------------------------------------------------------------------------
-- Item history: record which message caused a change, so it can be undone
-- ---------------------------------------------------------------------------
alter table item_event drop constraint item_event_action_check;
alter table item_event add constraint item_event_action_check
  check (action in ('created', 'edited', 'done', 'reopened', 'snoozed', 'undone', 'assigned', 'cancelled'));
alter table item_event
  add column source_message_id uuid references chat_message(id) on delete set null,
  add column undone_at timestamptz;   -- set when this change is reversed
-- Several events can land in one transaction; wall-clock time keeps them in order for undo.
alter table item_event alter column at set default clock_timestamp();
create index item_event_message_idx on item_event (source_message_id);

alter table suggestion add column item_ids uuid[] not null default '{}';   -- items created when accepted

-- ---------------------------------------------------------------------------
-- Household setup, callable from the app (Supabase RPC)
-- ---------------------------------------------------------------------------

-- First member creates the household and becomes its owner.
create or replace function create_household(p_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  h uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from member where user_id = auth.uid()) then raise exception 'already in a household'; end if;
  insert into household (name) values (p_name) returning id into h;
  insert into member (household_id, user_id, display_name, aliases, role)
    values (h, auth.uid(), p_display_name, array[lower(p_display_name)], 'owner');
  insert into list (household_id, name, kind) values (h, 'Shopping', 'shopping');
  return h;
end $$;

-- Everyone else joins with the invite code.
create or replace function join_household(p_invite_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  h uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from member where user_id = auth.uid()) then raise exception 'already in a household'; end if;
  select id into h from household where invite_code = upper(trim(p_invite_code));
  if h is null then raise exception 'invalid invite code'; end if;
  if (select count(*) from member where household_id = h) >= 8 then raise exception 'household is full'; end if;
  insert into member (household_id, user_id, display_name, aliases, role)
    values (h, auth.uid(), p_display_name, array[lower(p_display_name)], 'adult');
  return h;
end $$;

-- Members add nicknames ("papa", "bhaiya") that the parser matches.
create or replace function set_my_aliases(p_aliases text[])
returns void language sql security definer set search_path = public as $$
  update member set aliases = (select coalesce(array_agg(distinct lower(trim(a))), '{}') from unnest(p_aliases) a where trim(a) <> '')
  where user_id = auth.uid();
$$;

revoke all on function create_household(text, text), join_household(text, text), set_my_aliases(text[]) from public;
grant execute on function create_household(text, text), join_household(text, text), set_my_aliases(text[]) to authenticated;
