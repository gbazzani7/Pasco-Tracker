-- Pasco Site Tracker shared database setup
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.

create table if not exists public.parcels (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists parcels_set_updated_at on public.parcels;

create trigger parcels_set_updated_at
before update on public.parcels
for each row
execute function public.set_updated_at();

create index if not exists parcels_updated_at_idx
on public.parcels (updated_at desc);

create index if not exists parcels_status_idx
on public.parcels ((data->>'status'));

alter table public.parcels enable row level security;

drop policy if exists "pasco_tracker_read" on public.parcels;
drop policy if exists "pasco_tracker_insert" on public.parcels;
drop policy if exists "pasco_tracker_update" on public.parcels;

create policy "pasco_tracker_read"
on public.parcels
for select
to anon
using (true);

create policy "pasco_tracker_insert"
on public.parcels
for insert
to anon
with check (true);

create policy "pasco_tracker_update"
on public.parcels
for update
to anon
using (true)
with check (true);
