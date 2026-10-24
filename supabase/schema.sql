-- Fitted: one schema for every kind of small business.
-- Paste into Supabase > SQL editor and run once. Safe to re-run.

create extension if not exists btree_gist;

-- A business is a row plus a spec. The spec (jsonb) is what the AI writes:
-- resources, offerings, hours, layout, policies. The app renders from it, so a
-- padel club, a spin studio and a salon share every table and every line of code.
create table if not exists businesses (
  id                 uuid primary key default gen_random_uuid(),
  slug               text unique not null,
  name               text not null,
  owner_email        text,
  owner_key          text not null,          -- secret the owner's browser keeps; required for edits
  prompt             text not null,
  spec               jsonb not null,
  spec_version       int not null default 1,
  stripe_account_id  text,
  charges_enabled    boolean not null default false,
  created_at         timestamptz not null default now()
);

-- Every change to a spec is kept, so an owner can see what the AI changed and roll back.
create table if not exists spec_versions (
  id           bigint generated always as identity primary key,
  business_id  uuid not null references businesses(id) on delete cascade,
  version      int not null,
  instruction  text not null,
  spec         jsonb not null,
  created_at   timestamptz not null default now(),
  unique (business_id, version)
);

-- A booking holds one bookable unit (a court, a bike, a stylist) for a time range.
create table if not exists bookings (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id) on delete cascade,
  resource_key       text not null,
  offering_key       text not null,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  status             text not null default 'pending' check (status in ('pending','paid','cancelled')),
  hold_until         timestamptz not null default now() + interval '15 minutes',
  customer_name      text,
  customer_email     text,
  answers            jsonb not null default '{}',
  amount_cents       int not null,
  fee_cents          int not null,
  currency           text not null default 'eur',
  stripe_session_id  text,
  created_at         timestamptz not null default now(),
  check (ends_at > starts_at),
  -- No double bookings, enforced by Postgres itself rather than app code:
  -- two live bookings for the same unit can never overlap in time.
  constraint no_overlap exclude using gist (
    business_id with =,
    resource_key with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status <> 'cancelled')
);
create index if not exists bookings_business_time on bookings (business_id, starts_at);
create index if not exists bookings_session on bookings (stripe_session_id);

-- Every AI call is metered, so the owner dashboard can show what setup actually cost.
create table if not exists ai_calls (
  id             bigint generated always as identity primary key,
  business_id    uuid references businesses(id) on delete cascade,
  kind           text not null,          -- 'generate' | 'refine'
  model          text not null,
  input_tokens   int not null default 0,
  output_tokens  int not null default 0,
  cost_usd       numeric(10,6) not null default 0,
  created_at     timestamptz not null default now()
);

-- Release unpaid holds, then insert. One round trip; the exclusion constraint
-- turns a race between two customers into a clean error for the slower one.
create or replace function book_slot(
  p_business_id uuid, p_resource_key text, p_offering_key text,
  p_starts_at timestamptz, p_ends_at timestamptz,
  p_customer_name text, p_customer_email text, p_answers jsonb,
  p_amount_cents int, p_fee_cents int, p_currency text
) returns bookings
language plpgsql security definer set search_path = public as $$
declare b bookings;
begin
  update bookings set status = 'cancelled'
   where business_id = p_business_id and status = 'pending' and hold_until < now();
  insert into bookings (business_id, resource_key, offering_key, starts_at, ends_at,
                        customer_name, customer_email, answers, amount_cents, fee_cents, currency)
  values (p_business_id, p_resource_key, p_offering_key, p_starts_at, p_ends_at,
          p_customer_name, p_customer_email, coalesce(p_answers, '{}'), p_amount_cents, p_fee_cents, p_currency)
  returning * into b;
  return b;
end $$;

-- Row level security on, with no policies: the anon key can read or write nothing
-- in these tables. The server uses the service key. The only public surface is busy_slots.
alter table businesses    enable row level security;
alter table spec_versions enable row level security;
alter table bookings      enable row level security;
alter table ai_calls      enable row level security;

-- Customers see busy slots, never other customers' names or emails.
create or replace view busy_slots with (security_invoker = false) as
  select business_id, resource_key, starts_at, ends_at
    from bookings where status = 'paid' or (status = 'pending' and hold_until > now());
grant select on busy_slots to anon, authenticated;
