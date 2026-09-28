-- ============================================================================
-- Gahoi Portal — Migration 0001: Core Identity (persons, families, GahoiId)
-- भाग 1.3 (master document) का हिस्सा — Person + Family Unified Model (Phase C.1)
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- GahoiId / FamilyId generation — Postgres sequence से atomic, race-condition-free
-- (भाग 1.8 का safety-net यहीं naturally solve हो जाता है — कोई manual transaction
--  लिखने की ज़रूरत नहीं, sequence खुद ही concurrent-safe है)
-- ----------------------------------------------------------------------------
create sequence if not exists gahoi_id_seq start 1;
create sequence if not exists family_id_seq start 1;

create or replace function generate_next_gahoi_id()
returns text
language sql
as $$
  select 'GP' || lpad(nextval('gahoi_id_seq')::text, 8, '0');
$$;

create or replace function generate_next_family_id()
returns text
language sql
as $$
  select 'FAM' || lpad(nextval('family_id_seq')::text, 8, '0');
$$;

-- ----------------------------------------------------------------------------
-- updated_at auto-touch trigger — हर table पर reuse होगा
-- ----------------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- families
-- ----------------------------------------------------------------------------
create table if not exists families (
  family_id     text primary key default generate_next_family_id(),
  family_name   text,
  head_gahoi_id text,               -- FK to persons जोड़ा जाएगा नीचे (circular dependency से बचने के लिए)
  address       text,
  created_at    timestamptz not null default now(),
  created_by    text                -- gahoi_id of creator (member या coordinator)
);

-- ----------------------------------------------------------------------------
-- persons — मुख्य table, PK = gahoi_id
-- ----------------------------------------------------------------------------
create table if not exists persons (
  gahoi_id           text primary key default generate_next_gahoi_id(),
  auth_uid           uuid unique references auth.users(id) on delete set null,  -- खाली = census/unclaimed

  family_id          text references families(family_id) on delete set null,
  relation_to_head   text,          -- 'self'|'spouse'|'son'|'daughter'|'father'|'mother'|... (free-text भी)

  -- मूल जानकारी
  name               text not null,
  father             text,
  mobile             text,
  email              text,
  profession         text,
  designation        text,
  address            text,
  city               text,
  pincode            text,
  native             text,
  akna               text,
  bday               text,          -- 'MM-DD' format (मौजूदा pattern से consistent)
  anni               text,
  status             text not null default 'Pending',   -- 'Pending'|'Approved'|'Rejected'|'Inactive'
  role               text default '',                     -- 'Admin'|'Approver'|'mahasabhaPrint'|'kshetriyaPanchayat'|'localPanchayat'|''
  marital            text default 'Unmarried',
  spouse             text,
  show_mobile        text default 'yes',
  keywords           text[] default '{}',
  photo              text,
  blood_group        text,
  referred_by        text,          -- referrer का gahoi_id

  -- Phase 3 जैसे extra profile fields (JSON में, ताकि नए field जोड़ना आसान रहे)
  profile            jsonb default '{}'::jsonb,   -- streetAddress, locality, landmark, linkedin, twitter, instagram, facebook, hobbies, school, bio
  privacy_settings   jsonb default '{}'::jsonb,
  public_url_enabled boolean default false,
  profile_tier       text default 'Bronze',
  completion_percent int default 0,

  -- Residency vs Membership — दोनों अलग (भाग 1.3 का ज़रूरी नोट)
  residency          jsonb default '{}'::jsonb,   -- { localPanchayatId, kshetriyaSabha, mappedBy, mappedAt }
  membership         jsonb default '{}'::jsonb,   -- { kshetriyaMemberOf, localPanchayatMemberOf }
  role_scope         jsonb default '{}'::jsonb,

  -- Census/Claim workflow (Phase C.1)
  created_by         text,          -- gahoi_id of creator
  created_by_role    text,
  claim_status       text,          -- null | 'pendingClaim' | 'claimed'

  -- DPDP consent (भाग 9.4)
  consent                    jsonb default '{}'::jsonb,
  last_consent_review_date  timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- families.head_gahoi_id की FK अब जोड़ते हैं (persons बनने के बाद)
alter table families
  add constraint fk_families_head_gahoi_id
  foreign key (head_gahoi_id) references persons(gahoi_id) on delete set null;

create trigger trg_persons_updated_at
  before update on persons
  for each row execute function touch_updated_at();

-- Common query patterns के लिए indexes
create index if not exists idx_persons_auth_uid on persons(auth_uid);
create index if not exists idx_persons_family_id on persons(family_id);
create index if not exists idx_persons_status on persons(status);
create index if not exists idx_persons_city on persons(city);
create index if not exists idx_persons_akna on persons(akna);
create index if not exists idx_persons_native on persons(native);
create index if not exists idx_persons_mobile on persons(mobile);
create unique index if not exists idx_persons_email_lower on persons(lower(email)) where email is not null;
create index if not exists idx_persons_claim_status on persons(claim_status) where claim_status is not null;
-- Free-text search के लिए (name/city/native/akna/profession पर advanced search, भाग 3 Phase G)
create index if not exists idx_persons_search on persons
  using gin (to_tsvector('simple',
    coalesce(name,'') || ' ' || coalesce(city,'') || ' ' || coalesce(native,'') || ' ' ||
    coalesce(akna,'') || ' ' || coalesce(profession,'')));

-- ----------------------------------------------------------------------------
-- known_members — persons/{gahoiId}/knownMembers subcollection का flat-table रूप
-- ----------------------------------------------------------------------------
create table if not exists known_members (
  person_gahoi_id text not null references persons(gahoi_id) on delete cascade,
  known_gahoi_id  text not null references persons(gahoi_id) on delete cascade,
  added_at        timestamptz not null default now(),
  primary key (person_gahoi_id, known_gahoi_id)
);

-- ----------------------------------------------------------------------------
-- claim_requests — duplicate रोकने की Claim Mechanism (भाग 3, Phase C.1)
-- ----------------------------------------------------------------------------
create table if not exists claim_requests (
  id                      uuid primary key default gen_random_uuid(),
  unregistered_gahoi_id   text not null references persons(gahoi_id) on delete cascade,
  claimant_auth_uid       uuid not null references auth.users(id) on delete cascade,
  matched_fields          jsonb default '{}'::jsonb,   -- {name, akna, city, native, mobile}
  status                  text not null default 'pending',  -- pending|approved|rejected
  reviewed_by             text,          -- gahoi_id of reviewer
  reviewed_at             timestamptz,
  submitted_at            timestamptz not null default now()
);

create index if not exists idx_claim_requests_status on claim_requests(status);
create index if not exists idx_claim_requests_target on claim_requests(unregistered_gahoi_id);

-- ----------------------------------------------------------------------------
-- local_panchayats / mandals / mandal_members (भाग 3, Phase C)
-- ----------------------------------------------------------------------------
create table if not exists local_panchayats (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  kshetriya_sabha text not null,     -- कौन से 10 Kshetriya में से एक
  city_keywords  text[] default '{}',
  active         boolean default true,
  created_at     timestamptz not null default now()
);

create table if not exists mandals (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,          -- 'NavYuvak' | 'Mahila'
  level      text not null,          -- 'Mahasabha' | 'Kshetriya' | 'Local'
  parent_id  uuid,                   -- kshetriya_sabha id या local_panchayat id (polymorphic — application-level join)
  name       text,
  active     boolean default true,
  created_at timestamptz not null default now()
);

create table if not exists mandal_members (
  id             uuid primary key default gen_random_uuid(),
  mandal_id      uuid not null references mandals(id) on delete cascade,
  name           text not null,
  position       text,               -- free-text designation, कोई fixed list नहीं
  photo          text,
  contact        text,
  display_order  int default 0
);

-- ----------------------------------------------------------------------------
-- panchayat_memberships (भाग 3, Phase D) — Mahasabha+Kshetriya+Local, एक ही table
-- ----------------------------------------------------------------------------
create table if not exists panchayat_memberships (
  id               uuid primary key default gen_random_uuid(),
  member_gahoi_id  text not null references persons(gahoi_id) on delete cascade,
  level            text not null,     -- 'Mahasabha' | 'Kshetriya' | 'Local'
  panchayat_id     uuid,              -- local_panchayats.id (Kshetriya/Mahasabha के लिए null हो सकता है)
  status           text not null default 'Pending',
  fee              numeric(10,2),
  order_id         text,
  payment_id       text,
  applied_at       timestamptz not null default now(),
  approved_by      text
);

create index if not exists idx_panchayat_memberships_member on panchayat_memberships(member_gahoi_id);
create index if not exists idx_panchayat_memberships_status on panchayat_memberships(status);
