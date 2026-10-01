-- Stand-ins for what Supabase provides, so the migrations run on plain Postgres
-- (local development and tests). Never apply this to a Supabase project.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
-- Supabase reads the signed-in user from the JWT; locally, tests set request.jwt.claim.sub.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;
