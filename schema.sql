-- Ticket P&L Tracker — run this once in Supabase: SQL Editor → New query → paste → Run.
-- Every row belongs to the signed-in user, and row-level security makes sure
-- nobody else (even with the public anon key) can read or change it.

create table if not exists public.orders (
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_number     text not null,
  email            text,
  event_name       text,
  event_date_raw   text,
  seats            text,
  quantity         integer,
  buyer            text,
  date_bought_raw  text,
  card             text,
  total            numeric,
  price_per_ticket text,
  site             text,
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, order_number)
);

create table if not exists public.sales (
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sale_key       text not null,
  sold_at        timestamptz,
  sold_raw       text,
  result         text,
  event          text,
  event_date     date,
  venue          text,
  section        text,
  row_name       text,
  qty            integer,
  total          numeric,
  profit         numeric,
  roi            numeric,
  cost_per       numeric,
  sold_per       numeric,
  purchased_at   timestamptz,
  time_to_sell   text,
  marketplace    text,
  public_notes   text,
  order_numbers  text[],
  internal_notes text,
  created_at     timestamptz not null default now(),
  primary key (user_id, sale_key)
);

create table if not exists public.artist_overrides (
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  raw_name text not null,
  artist   text not null,
  primary key (user_id, raw_name)
);

create index if not exists sales_user_sold_idx on public.sales (user_id, sold_at);

alter table public.orders           enable row level security;
alter table public.sales            enable row level security;
alter table public.artist_overrides enable row level security;

drop policy if exists "own orders" on public.orders;
drop policy if exists "own sales" on public.sales;
drop policy if exists "own overrides" on public.artist_overrides;

create policy "own orders" on public.orders
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own sales" on public.sales
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own overrides" on public.artist_overrides
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
