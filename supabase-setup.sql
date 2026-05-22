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

create table if not exists public.tracker_users (
  email text primary key,
  added_at timestamptz not null default now()
);

insert into public.tracker_users (email)
values ('gregg.bazzani1@gmail.com')
on conflict (email) do nothing;

-- Future approved users:
-- 1. Create their email/password user in Supabase Authentication.
-- 2. Add their email here with:
-- insert into public.tracker_users (email) values ('coworker@example.com') on conflict do nothing;

alter table public.tracker_users enable row level security;

create or replace function public.is_pasco_tracker_user()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.tracker_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on public.tracker_users from anon, authenticated;
revoke execute on function public.is_pasco_tracker_user() from public;
grant execute on function public.is_pasco_tracker_user() to authenticated;

alter table public.parcels enable row level security;

drop policy if exists "pasco_tracker_read" on public.parcels;
drop policy if exists "pasco_tracker_insert" on public.parcels;
drop policy if exists "pasco_tracker_update" on public.parcels;
drop policy if exists "pasco_tracker_read_signed_in" on public.parcels;
drop policy if exists "pasco_tracker_insert_signed_in" on public.parcels;
drop policy if exists "pasco_tracker_update_signed_in" on public.parcels;

revoke all on public.parcels from anon;
grant select, insert, update on public.parcels to authenticated;

create policy "pasco_tracker_read_signed_in"
on public.parcels
for select
to authenticated
using (public.is_pasco_tracker_user());

create policy "pasco_tracker_insert_signed_in"
on public.parcels
for insert
to authenticated
with check (public.is_pasco_tracker_user());

create policy "pasco_tracker_update_signed_in"
on public.parcels
for update
to authenticated
using (public.is_pasco_tracker_user())
with check (public.is_pasco_tracker_user());
