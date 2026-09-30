-- ============================================================================
-- Gahoi Portal — Migration 0003: Financial, Audit & Operational Tables
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Daan Seva — Donations (भाग 3, Phase E)
-- ----------------------------------------------------------------------------
create table if not exists donation_campaigns (
  id uuid primary key default gen_random_uuid(),
  title text not null, description text, target_amount numeric(12,2),
  raised_amount numeric(12,2) default 0, image text,
  status text not null default 'Active',   -- Active|Closed
  created_by text references persons(gahoi_id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists donations (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references donation_campaigns(id) on delete set null,
  donor_gahoi_id text references persons(gahoi_id),
  donor_name text, donor_mobile text, donor_email text,   -- anonymous/non-member donors के लिए भी
  amount numeric(12,2) not null,
  order_id text, payment_id text,
  status text not null default 'Pending',   -- Pending|Success|Failed|Refunded
  receipt_sent boolean default false,
  created_at timestamptz not null default now()
);

create table if not exists donation_pledges (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references donation_campaigns(id) on delete cascade,
  pledger_gahoi_id text references persons(gahoi_id),
  amount numeric(12,2) not null,
  status text not null default 'Pending',    -- Pending|Fulfilled|Cancelled
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_donations_campaign on donations(campaign_id);
create index if not exists idx_donations_status on donations(status);

-- ----------------------------------------------------------------------------
-- Ledger (income/expense tracking — मौजूदा GAS Ledger sheet का replacement)
-- ----------------------------------------------------------------------------
create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  entry_type text not null,     -- 'income' | 'expense'
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  category text,
  added_by text references persons(gahoi_id),
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_date on ledger_entries(entry_date desc);
create index if not exists idx_ledger_type on ledger_entries(entry_type);

-- ----------------------------------------------------------------------------
-- Audit Log — हर sensitive action यहीं लिखा जाएगा
-- ----------------------------------------------------------------------------
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  logged_at timestamptz not null default now(),
  action text not null,          -- 'REGISTER'|'LOGIN'|'APPROVE'|'DELETE_MEMBER' आदि
  actor_gahoi_id text,
  actor_name text,
  actor_email text,
  target text,
  detail text,
  result text default 'SUCCESS'
);

create index if not exists idx_audit_log_logged_at on audit_log(logged_at desc);
create index if not exists idx_audit_log_action on audit_log(action);

-- ----------------------------------------------------------------------------
-- Feedback / Pending Signups
-- ----------------------------------------------------------------------------
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  submitted_by text references persons(gahoi_id),
  category text, message text not null,
  status text default 'Open',    -- Open|Reviewed|Closed
  created_at timestamptz not null default now()
);

create table if not exists pending_signups (
  email text primary key,
  name text, photo text,
  first_visit timestamptz not null default now(),
  last_visit timestamptz not null default now(),
  emails_sent jsonb default '[]'::jsonb,
  completed_at timestamptz,
  google_sub text
);

-- ----------------------------------------------------------------------------
-- Advertising & Sponsorship (भाग 3)
-- ----------------------------------------------------------------------------
create table if not exists ads (
  id uuid primary key default gen_random_uuid(),
  advertiser_name text not null, advertiser_contact text,
  image_url text, link_url text, placement text not null,
  start_date date, end_date date,
  status text not null default 'PendingApproval',  -- PendingApproval|Approved|Rejected|Expired
  amount numeric(10,2), order_id text, payment_id text,
  created_at timestamptz not null default now()
);

create table if not exists sponsorships (
  id uuid primary key default gen_random_uuid(),
  sponsor_name text not null, sponsor_logo text,
  linked_entity_type text,      -- 'event' | 'magazine'
  linked_entity_id uuid,
  tier text, amount numeric(10,2),
  status text not null default 'PendingApproval',
  order_id text, payment_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ads_status on ads(status);

-- ----------------------------------------------------------------------------
-- Settings — key-value config store (matrimony/daanSeva/paymentAccounts/siteContent/legalPages/notifications/trustInfo)
-- ----------------------------------------------------------------------------
create table if not exists settings (
  doc_id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace trigger trg_settings_updated_at
  before update on settings
  for each row execute function touch_updated_at();
