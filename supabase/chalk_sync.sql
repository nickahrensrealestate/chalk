-- Chalk cloud sync: the one table m-sync.js uses (M.cloud).
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- How it works
-- * A household is a random 20-character code (letters and digits, never I, O, 0 or 1).
-- * The app sends that code ONLY in the "x-household" request header, never in a URL.
--   Row-level security shows and writes only the rows of the household in that header.
-- * Rows are never deleted: deleted = true marks a removed record (and "Delete my cloud
--   data" marks every row of a household that way). There is no delete policy.
-- * updated_at is set by the server on every insert and update. Pulls page on it, so the
--   trigger below is required; the app's "turn on" self-test checks that it works.

create table if not exists public.chalk_sync (
  household      text        not null check (household ~ '^[A-HJ-NP-Z2-9]{20}$'),
  kind           text        not null check (kind in ('food', 'meal', 'day', 'body', 'profile', 'train', 'meta')),
  id             text        not null check (char_length(id) between 1 and 200),
  data           jsonb       not null default '{}'::jsonb check (octet_length(data::text) < 3000000),
  deleted        boolean     not null default false,
  client_updated bigint      not null default 0,
  device         text        not null default '' check (char_length(device) <= 64),
  updated_at     timestamptz not null default now(),
  primary key (household, kind, id)
);

-- Server time on every write. One upsert request = one transaction = one now() for all its rows.
create or replace function public.chalk_sync_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists chalk_sync_stamp on public.chalk_sync;
create trigger chalk_sync_stamp
  before insert or update on public.chalk_sync
  for each row execute function public.chalk_sync_stamp();

-- Pulls: where household = <header> and updated_at > <cursor> order by updated_at, kind, id.
create index if not exists chalk_sync_household_updated
  on public.chalk_sync (household, updated_at, kind, id);

-- Row-level security: a request only sees and writes its own household (from the header).
alter table public.chalk_sync enable row level security;

drop policy if exists chalk_sync_select on public.chalk_sync;
create policy chalk_sync_select on public.chalk_sync
  for select to anon
  using (household = coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-household', ''));

drop policy if exists chalk_sync_insert on public.chalk_sync;
create policy chalk_sync_insert on public.chalk_sync
  for insert to anon
  with check (household = coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-household', ''));

drop policy if exists chalk_sync_update on public.chalk_sync;
create policy chalk_sync_update on public.chalk_sync
  for update to anon
  using (household = coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-household', ''))
  with check (household = coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-household', ''));

-- No delete policy, and no delete grant: rows are only ever marked deleted.
revoke all on table public.chalk_sync from anon, authenticated;
grant select, insert, update on table public.chalk_sync to anon;
