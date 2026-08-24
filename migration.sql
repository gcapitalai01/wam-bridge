-- G Capital AI — WhatsApp QR Bridge tables

create table if not exists wam_clients (
  business_id uuid primary key references businesses(id) on delete cascade,
  status text not null default 'not_started', -- qr_pending | connected | disconnected | reconnecting
  phone text,
  updated_at timestamptz not null default now()
);

create table if not exists wam_messages (
  id bigint generated always as identity primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  phone text not null,
  text text,
  created_at timestamptz not null default now()
);
create index if not exists wam_messages_business_idx on wam_messages(business_id, created_at desc);

-- Baileys auth/session credentials (replaces local /auth_info files — required because Render's disk is ephemeral)
create table if not exists wam_auth_state (
  business_id uuid not null references businesses(id) on delete cascade,
  data_key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (business_id, data_key)
);

alter table wam_clients enable row level security;
alter table wam_messages enable row level security;
alter table wam_auth_state enable row level security;

-- Only service role (used by this bridge + dashboard backend) touches these tables directly.
-- No public/anon policies added on purpose — matches pattern used by other tentacle tables.
