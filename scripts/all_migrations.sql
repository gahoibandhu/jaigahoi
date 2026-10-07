-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0001_core_identity.sql
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
-- Postgres में ADD CONSTRAINT IF NOT EXISTS नहीं होता (CREATE TABLE IF NOT EXISTS
-- जैसा) — इसलिए DO block से खुद check करके guard किया, ताकि यह migration किसी
-- ऐसे DB पर दोबारा चले (जहाँ tables पहले से manually/किसी और तरीक़े से बन चुके थे)
-- तो यह statement fail ना हो और पूरा deploy pipeline (migrations + functions) आगे बढ़ सके।
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fk_families_head_gahoi_id'
  ) then
    alter table families
      add constraint fk_families_head_gahoi_id
      foreign key (head_gahoi_id) references persons(gahoi_id) on delete set null;
  end if;
end $$;

create or replace trigger trg_persons_updated_at
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
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0002_matrimony_and_content.sql
-- ============================================================================
-- Gahoi Portal — Migration 0002: Matrimony, Content, Messaging
-- ============================================================================

-- ----------------------------------------------------------------------------
-- matrimony_profiles
-- ----------------------------------------------------------------------------
create table if not exists matrimony_profiles (
  id                uuid primary key default gen_random_uuid(),
  created_by        text not null references persons(gahoi_id) on delete cascade,
  status            text not null default 'Approved',   -- Approved|Inactive|Pending
  profile_for       text, gender text, marital text,
  name              text, dob text, height text, complexion text, manglik text,
  education text, occupation text, income text, city text, native text,
  gotra text, akna text, father text, father_occ text, mother text, mama text,
  brothers text, sisters text, mobile text, contact_name text,
  pref_edu text, pref_age text, pref_city text, pref_other text, about text,
  photo text, address text, birth_time text, birth_city text,
  rashi text, gan text, nakshatra text,
  dadaji text, nanaji text, tau text, bua text, chacha text, mausi text, didi text, dadiji text, naniji text,

  tier              text not null default 'Gold',        -- Gold|Platinum|Diamond
  photos            jsonb default '[]'::jsonb,
  photo_privacy     text default 'all',
  valid_until       date,
  tier_start_date   date,
  expiry_notified   text default '',
  job_company       text, job_city text,

  verification      jsonb default '{"status":"unverified"}'::jsonb,
  -- { status: unverified|pending|verified|rejected, docUrl(private, admin-only), verifiedBy, verifiedAt }

  deleted_at        timestamptz,
  deleted_by        text,
  created_at        timestamptz not null default now(),
  edited_at         timestamptz not null default now()
);

create index if not exists idx_matrimony_created_by on matrimony_profiles(created_by);
create index if not exists idx_matrimony_status on matrimony_profiles(status) where deleted_at is null;
create index if not exists idx_matrimony_gender_city on matrimony_profiles(gender, city) where deleted_at is null;

-- edited_at column के लिए अलग touch-function (matrimony_profiles में updated_at नहीं, edited_at नाम है)
create or replace function touch_updated_at_edited()
returns trigger language plpgsql as $$
begin
  new.edited_at = now();
  return new;
end;
$$;

create or replace trigger trg_matrimony_edited_at
  before update on matrimony_profiles
  for each row execute function touch_updated_at_edited();

-- ----------------------------------------------------------------------------
-- matrimony_interests (bidirectional + live, भाग 3 Phase F.1)
-- ----------------------------------------------------------------------------
create table if not exists matrimony_interests (
  id             uuid primary key default gen_random_uuid(),
  from_gahoi_id  text not null references persons(gahoi_id) on delete cascade,
  to_profile_id  uuid not null references matrimony_profiles(id) on delete cascade,
  type           text not null,          -- 'shortlist' | 'interest'
  status         text not null default 'pending',  -- pending|mutual|declined
  seen_by_owner  boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (from_gahoi_id, to_profile_id, type)
);

create index if not exists idx_mat_interests_to_profile on matrimony_interests(to_profile_id);
create index if not exists idx_mat_interests_from on matrimony_interests(from_gahoi_id);

-- ----------------------------------------------------------------------------
-- Community content tables
-- ----------------------------------------------------------------------------
create table if not exists business_listings (
  id uuid primary key default gen_random_uuid(),
  posted_by text references persons(gahoi_id),
  firm text, industry text, person text, desig text, address text, pincode text,
  city text, maps text, mobile text, email text, keywords text, photo text,
  featured boolean default false, featured_until date, feature_payment_id text,
  posted_at timestamptz not null default now(),
  edited_at timestamptz not null default now(),
  deleted_at timestamptz, deleted_by text
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  posted_by text references persons(gahoi_id),
  title text, company text, location text, type text, salary text, exp text,
  description text, mobile text, email text,
  featured boolean default false, featured_until date, feature_payment_id text,
  posted_at timestamptz not null default now(),
  deleted_at timestamptz, deleted_by text
);

create table if not exists community_events (
  id uuid primary key default gen_random_uuid(),
  title text, description text, event_date date, image text,
  created_at timestamptz not null default now(), deleted_at timestamptz
);

create table if not exists gallery (
  id uuid primary key default gen_random_uuid(),
  url text not null, caption text, album text default 'General',
  uploader text, created_at timestamptz not null default now(), deleted_at timestamptz
);

create table if not exists dharmshala (
  id uuid primary key default gen_random_uuid(),
  state text, city text, name text, address text, person text, contact text, maps text,
  posted_at timestamptz not null default now()
);

create table if not exists magazines (
  id uuid primary key default gen_random_uuid(),
  title text, description text, cover_image text, file_url text,
  month text, year text, posted_at timestamptz not null default now(), posted_by text
);

-- ----------------------------------------------------------------------------
-- Messaging (WhatsApp-style conversations)
-- ----------------------------------------------------------------------------
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  participant_a text not null references persons(gahoi_id),
  participant_b text not null references persons(gahoi_id),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  unique (participant_a, participant_b)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  from_gahoi_id text not null references persons(gahoi_id),
  to_gahoi_id   text not null references persons(gahoi_id),
  body text not null,
  sent_at timestamptz not null default now(),
  read boolean not null default false,
  deleted boolean not null default false
);

create index if not exists idx_messages_conversation on messages(conversation_id, sent_at);
create index if not exists idx_conversations_participants on conversations(participant_a, participant_b);

-- ----------------------------------------------------------------------------
-- Gahoi Space (social feed)
-- ----------------------------------------------------------------------------
create table if not exists space_posts (
  id uuid primary key default gen_random_uuid(),
  author_gahoi_id text not null references persons(gahoi_id),
  posted_at timestamptz not null default now(),
  text text not null,
  image_url text,
  liked_by text[] default '{}',
  comment_count int default 0,
  status text not null default 'Active',   -- Active|Deleted
  deleted_at timestamptz, deleted_by text,
  edited_at timestamptz
);

create table if not exists space_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references space_posts(id) on delete cascade,
  author_gahoi_id text not null references persons(gahoi_id),
  posted_at timestamptz not null default now(),
  text text not null,
  status text not null default 'Active',
  deleted_at timestamptz, deleted_by text
);

create index if not exists idx_space_posts_posted_at on space_posts(posted_at desc) where status = 'Active';
create index if not exists idx_space_comments_post on space_comments(post_id);
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0003_financial_and_operations.sql
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
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0004_dpdp_compliance.sql
-- ============================================================================
-- Gahoi Portal — Migration 0004: DPDP Compliance Tables (भाग 9)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- data_requests (भाग 9.6) — access/correction/deletion/consent-withdrawal आदि
-- ----------------------------------------------------------------------------
create sequence if not exists data_request_id_seq start 1;

create table if not exists data_requests (
  id                    uuid primary key default gen_random_uuid(),
  request_id            text unique not null default ('DR' || lpad(nextval('data_request_id_seq')::text, 8, '0')),
  user_gahoi_id         text not null references persons(gahoi_id),
  request_type          text not null,   -- access|correction|update|consentWithdrawal|profileRestriction|
                                          -- matrimonyProfilePause|deletion|commsOptOut|privacyComplaint|grievanceEscalation
  request_description   text,
  received_at           timestamptz not null default now(),
  assigned_to           text references persons(gahoi_id),
  due_date              date,
  status                text not null default 'Open',   -- Open|InProgress|Closed
  action_taken          text,
  closed_at             timestamptz,
  closure_reason        text,
  supporting_documents  jsonb default '[]'::jsonb,
  audit_trail           jsonb default '[]'::jsonb
);

create index if not exists idx_data_requests_user on data_requests(user_gahoi_id);
create index if not exists idx_data_requests_status on data_requests(status);

-- ----------------------------------------------------------------------------
-- security_incidents (भाग 9.14)
-- ----------------------------------------------------------------------------
create sequence if not exists security_incident_id_seq start 1;

create table if not exists security_incidents (
  id                  uuid primary key default gen_random_uuid(),
  incident_id         text unique not null default ('INC' || lpad(nextval('security_incident_id_seq')::text, 8, '0')),
  date_time           timestamptz not null default now(),
  reported_by         text references persons(gahoi_id),
  affected_module     text,
  affected_records    text,
  severity            text,          -- Low|Medium|High|Critical
  immediate_action    text,
  root_cause          text,
  corrective_action   text,
  responsible_owner   text references persons(gahoi_id),
  closure_date        timestamptz
);

-- ----------------------------------------------------------------------------
-- privacy_documents (भाग 9.12) — Privacy Notice/Terms/Matrimony-T&C/Consent-Policy आदि
-- ----------------------------------------------------------------------------
create table if not exists privacy_documents (
  doc_id              text primary key,   -- 'privacy-notice', 'terms-of-use', 'matrimony-tnc', ...
  version             text not null,
  effective_date      date not null,
  approval_authority  text,
  last_updated_date   timestamptz not null default now(),
  content             text,               -- rendered HTML/Markdown content
  change_history      jsonb default '[]'::jsonb
);
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0005_rls_policies.sql
-- ============================================================================
-- Gahoi Portal — Migration 0005: RLS Policies + Helper Functions
-- ============================================================================
--
-- ⚠️ ज़रूरी architectural नोट (भाग 9.10 का व्यावहारिक असर):
-- Postgres RLS सिर्फ़ ROW-LEVEL access control करती है ("इस row को देख सकते हो या
-- नहीं") — COLUMN-LEVEL masking (जैसे "mobile सिर्फ़ तभी दिखे जब privacy setting
-- allow करे", या "matrimony contact सिर्फ़ mutual-interest के बाद") RLS खुद नहीं
-- करती। इसके लिए दो तरीक़े इस्तेमाल होंगे (मौजूदा Code.gs के safeUser()/doMemberPublic()
-- pattern जैसा ही, बस अब SQL में):
--   1. `persons_public` जैसे VIEWs — सिर्फ़ safe columns project करते हैं, frontend
--      सीधे इन्हीं VIEWs से पढ़ेगा (Directory listing, Search, Public profile)
--   2. Edge Functions — जहाँ conditional/privacy-setting-आधारित masking चाहिए
--      (जैसे mobile दिखाना है या नहीं, showMobile/privacy JSON के हिसाब से) वहाँ
--      पूरा row RLS से मिलेगा, पर Edge Function खुद फ़ील्ड्स filter करके भेजेगा
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions — current user कौन है, क्या role है
-- ----------------------------------------------------------------------------
create or replace function current_gahoi_id()
returns text
language sql stable security definer
as $$
  select gahoi_id from persons where auth_uid = auth.uid() limit 1;
$$;

create or replace function current_person_role()
returns text
language sql stable security definer
as $$
  select role from persons where auth_uid = auth.uid() limit 1;
$$;

create or replace function is_admin()
returns boolean language sql stable security definer as $$
  select coalesce(current_person_role() = 'Admin', false);
$$;

create or replace function is_approver_or_admin()
returns boolean language sql stable security definer as $$
  select coalesce(current_person_role() in ('Admin','Approver'), false);
$$;

create or replace function is_approved_member()
returns boolean language sql stable security definer as $$
  select exists(select 1 from persons where auth_uid = auth.uid() and status = 'Approved');
$$;

-- नोट: भाग 5 के फ़ैसले अनुसार Finance/Content-Mod/DPO/Matrimony-Verification अलग roles नहीं —
-- field-level flags होंगे। जब तक वो flags तय ना हों, उनके लिए access फ़िलहाल is_approver_or_admin()
-- से होगा (यानी Admin/Approver ही चला सकते हैं) — flags बनने पर यहाँ नए helper functions जुड़ेंगे।

-- ----------------------------------------------------------------------------
-- persons
-- ----------------------------------------------------------------------------
alter table persons enable row level security;

-- कोई भी logged-in approved member, दूसरे approved members की पूरी row पढ़ सकता है
-- (column-masking अलग से persons_public VIEW/Edge-Function में — ऊपर नोट देखें)
drop policy if exists persons_select_approved on persons;
create policy persons_select_approved on persons
  for select using (
    status = 'Approved' or auth_uid = auth.uid() or is_approver_or_admin()
  );

-- अपनी ही row अपडेट कर सकते हैं (status/role खुद नहीं बदल सकते — वो सिर्फ़ Edge Function से,
-- यहाँ WITH CHECK में उन fields को protect करना अलग trigger से होगा, अभी basic policy)
drop policy if exists persons_update_own on persons;
create policy persons_update_own on persons
  for update using (auth_uid = auth.uid() or is_admin())
  with check (auth_uid = auth.uid() or is_admin());

-- नया व्यक्ति सिर्फ़ खुद के लिए insert कर सकता है (registration flow, Edge Function से गुज़रेगा)
drop policy if exists persons_insert_self on persons;
create policy persons_insert_self on persons
  for insert with check (auth_uid = auth.uid() or is_approver_or_admin());

drop policy if exists persons_delete_admin_only on persons;
create policy persons_delete_admin_only on persons
  for delete using (is_admin());

-- Public-facing "safe" view — Directory/Search/Public-profile यहीं से पढ़ेंगे
create or replace view persons_public as
  select gahoi_id, name, city, native, akna, profession, designation, photo,
         blood_group, marital, profile_tier
    -- mobile/email/address जानबूझकर शामिल नहीं — वो privacy-aware masking Edge Function से
  from persons
  where status = 'Approved';

-- ----------------------------------------------------------------------------
-- families
-- ----------------------------------------------------------------------------
alter table families enable row level security;

drop policy if exists families_select_members on families;
create policy families_select_members on families
  for select using (
    is_approver_or_admin() or
    exists (select 1 from persons p where p.family_id = families.family_id and p.auth_uid = auth.uid())
  );

drop policy if exists families_write_admin on families;
create policy families_write_admin on families
  for all using (is_approver_or_admin()) with check (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- known_members
-- ----------------------------------------------------------------------------
alter table known_members enable row level security;

drop policy if exists known_members_own on known_members;
create policy known_members_own on known_members
  for all using (person_gahoi_id = current_gahoi_id() or is_admin())
  with check (person_gahoi_id = current_gahoi_id());

-- ----------------------------------------------------------------------------
-- claim_requests
-- ----------------------------------------------------------------------------
alter table claim_requests enable row level security;

drop policy if exists claim_requests_own_or_admin on claim_requests;
create policy claim_requests_own_or_admin on claim_requests
  for select using (claimant_auth_uid = auth.uid() or is_approver_or_admin());

drop policy if exists claim_requests_insert_own on claim_requests;
create policy claim_requests_insert_own on claim_requests
  for insert with check (claimant_auth_uid = auth.uid());

drop policy if exists claim_requests_update_admin on claim_requests;
create policy claim_requests_update_admin on claim_requests
  for update using (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- local_panchayats / mandals / mandal_members — public read, admin write
-- ----------------------------------------------------------------------------
alter table local_panchayats enable row level security;
alter table mandals enable row level security;
alter table mandal_members enable row level security;

drop policy if exists lp_read_all on local_panchayats;
create policy lp_read_all on local_panchayats for select using (true);
drop policy if exists lp_write_admin on local_panchayats;
create policy lp_write_admin on local_panchayats for all using (is_admin()) with check (is_admin());

drop policy if exists mandals_read_all on mandals;
create policy mandals_read_all on mandals for select using (true);
drop policy if exists mandals_write_admin on mandals;
create policy mandals_write_admin on mandals for all using (is_admin()) with check (is_admin());

drop policy if exists mandal_members_read_all on mandal_members;
create policy mandal_members_read_all on mandal_members for select using (true);
drop policy if exists mandal_members_write_admin on mandal_members;
create policy mandal_members_write_admin on mandal_members for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- panchayat_memberships
-- ----------------------------------------------------------------------------
alter table panchayat_memberships enable row level security;

drop policy if exists pm_select_own_or_admin on panchayat_memberships;
create policy pm_select_own_or_admin on panchayat_memberships
  for select using (member_gahoi_id = current_gahoi_id() or is_approver_or_admin());

drop policy if exists pm_insert_own on panchayat_memberships;
create policy pm_insert_own on panchayat_memberships
  for insert with check (member_gahoi_id = current_gahoi_id());

drop policy if exists pm_update_admin on panchayat_memberships;
create policy pm_update_admin on panchayat_memberships
  for update using (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- matrimony_profiles — highly restricted (भाग 9.7)
-- ----------------------------------------------------------------------------
alter table matrimony_profiles enable row level security;

-- सिर्फ़ approved members पूरा profile देख सकते हैं (contact-masking अभी भी Edge Function से,
-- mutual-interest से पहले mobile ना दिखे — VIEW में column छोड़ा जा सकता है अगर पूरी तरह hide करना हो)
drop policy if exists matrimony_select_approved_members on matrimony_profiles;
create policy matrimony_select_approved_members on matrimony_profiles
  for select using (
    (status = 'Approved' and deleted_at is null and is_approved_member())
    or created_by = current_gahoi_id()
    or is_approver_or_admin()
  );

drop policy if exists matrimony_insert_own on matrimony_profiles;
create policy matrimony_insert_own on matrimony_profiles
  for insert with check (created_by = current_gahoi_id());

drop policy if exists matrimony_update_own_or_admin on matrimony_profiles;
create policy matrimony_update_own_or_admin on matrimony_profiles
  for update using (created_by = current_gahoi_id() or is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- matrimony_interests — सिर्फ़ भेजने वाला और profile-owner देख सकते हैं
-- ----------------------------------------------------------------------------
alter table matrimony_interests enable row level security;

drop policy if exists mat_interests_select on matrimony_interests;
create policy mat_interests_select on matrimony_interests
  for select using (
    from_gahoi_id = current_gahoi_id()
    or exists (select 1 from matrimony_profiles mp where mp.id = to_profile_id and mp.created_by = current_gahoi_id())
    or is_approver_or_admin()
  );

drop policy if exists mat_interests_insert on matrimony_interests;
create policy mat_interests_insert on matrimony_interests
  for insert with check (from_gahoi_id = current_gahoi_id());

drop policy if exists mat_interests_update on matrimony_interests;
create policy mat_interests_update on matrimony_interests
  for update using (
    from_gahoi_id = current_gahoi_id()
    or exists (select 1 from matrimony_profiles mp where mp.id = to_profile_id and mp.created_by = current_gahoi_id())
  );

-- ----------------------------------------------------------------------------
-- Community content — public/approved-member read, own-or-admin write
-- ----------------------------------------------------------------------------
alter table business_listings enable row level security;
alter table jobs enable row level security;
alter table community_events enable row level security;
alter table gallery enable row level security;
alter table dharmshala enable row level security;
alter table magazines enable row level security;

drop policy if exists biz_read_all on business_listings;
create policy biz_read_all on business_listings for select using (deleted_at is null);
drop policy if exists biz_write_own_or_admin on business_listings;
create policy biz_write_own_or_admin on business_listings for all
  using (posted_by = current_gahoi_id() or is_approver_or_admin())
  with check (posted_by = current_gahoi_id() or is_approver_or_admin());

drop policy if exists jobs_read_all on jobs;
create policy jobs_read_all on jobs for select using (deleted_at is null);
drop policy if exists jobs_write_own_or_admin on jobs;
create policy jobs_write_own_or_admin on jobs for all
  using (posted_by = current_gahoi_id() or is_approver_or_admin())
  with check (posted_by = current_gahoi_id() or is_approver_or_admin());

drop policy if exists events_read_all on community_events;
create policy events_read_all on community_events for select using (deleted_at is null);
drop policy if exists events_write_admin on community_events;
create policy events_write_admin on community_events for all using (is_admin()) with check (is_admin());

drop policy if exists gallery_read_all on gallery;
create policy gallery_read_all on gallery for select using (deleted_at is null);
drop policy if exists gallery_write_admin on gallery;
create policy gallery_write_admin on gallery for all using (is_approver_or_admin()) with check (is_approver_or_admin());

drop policy if exists dharmshala_read_all on dharmshala;
create policy dharmshala_read_all on dharmshala for select using (true);
drop policy if exists dharmshala_write_admin on dharmshala;
create policy dharmshala_write_admin on dharmshala for all using (is_admin()) with check (is_admin());

drop policy if exists magazines_read_all on magazines;
create policy magazines_read_all on magazines for select using (true);
drop policy if exists magazines_write_admin on magazines;
create policy magazines_write_admin on magazines for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- Messaging — सिर्फ़ participants
-- ----------------------------------------------------------------------------
alter table conversations enable row level security;
alter table messages enable row level security;

drop policy if exists conversations_participants on conversations;
create policy conversations_participants on conversations
  for select using (participant_a = current_gahoi_id() or participant_b = current_gahoi_id() or is_admin());

drop policy if exists conversations_insert on conversations;
create policy conversations_insert on conversations
  for insert with check (participant_a = current_gahoi_id() or participant_b = current_gahoi_id());

drop policy if exists messages_participants on messages;
create policy messages_participants on messages
  for select using (from_gahoi_id = current_gahoi_id() or to_gahoi_id = current_gahoi_id() or is_admin());

drop policy if exists messages_insert_own on messages;
create policy messages_insert_own on messages
  for insert with check (from_gahoi_id = current_gahoi_id());

drop policy if exists messages_update_participants on messages;
create policy messages_update_participants on messages
  for update using (from_gahoi_id = current_gahoi_id() or to_gahoi_id = current_gahoi_id());

-- ----------------------------------------------------------------------------
-- Gahoi Space (social feed) — approved members read/write, own-or-admin delete
-- ----------------------------------------------------------------------------
alter table space_posts enable row level security;
alter table space_comments enable row level security;

drop policy if exists space_posts_read on space_posts;
create policy space_posts_read on space_posts for select using (status = 'Active' or is_admin());
drop policy if exists space_posts_insert on space_posts;
create policy space_posts_insert on space_posts for insert with check (author_gahoi_id = current_gahoi_id());
drop policy if exists space_posts_update on space_posts;
create policy space_posts_update on space_posts for update
  using (author_gahoi_id = current_gahoi_id() or is_approver_or_admin());

drop policy if exists space_comments_read on space_comments;
create policy space_comments_read on space_comments for select using (status = 'Active' or is_admin());
drop policy if exists space_comments_insert on space_comments;
create policy space_comments_insert on space_comments for insert with check (author_gahoi_id = current_gahoi_id());
drop policy if exists space_comments_update on space_comments;
create policy space_comments_update on space_comments for update
  using (author_gahoi_id = current_gahoi_id() or is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- Financial tables — Admin/Finance-flag only (भाग 9.8 access-principle)
-- ----------------------------------------------------------------------------
alter table donation_campaigns enable row level security;
alter table donations enable row level security;
alter table donation_pledges enable row level security;
alter table ledger_entries enable row level security;

drop policy if exists campaigns_read_all on donation_campaigns;
create policy campaigns_read_all on donation_campaigns for select using (true);
drop policy if exists campaigns_write_admin on donation_campaigns;
create policy campaigns_write_admin on donation_campaigns for all using (is_approver_or_admin()) with check (is_approver_or_admin());

drop policy if exists donations_own_or_admin on donations;
create policy donations_own_or_admin on donations
  for select using (donor_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists donations_insert on donations;
create policy donations_insert on donations for insert with check (true);  -- anonymous donors भी कर सकते हैं

drop policy if exists pledges_own_or_admin on donation_pledges;
create policy pledges_own_or_admin on donation_pledges
  for select using (pledger_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists pledges_insert on donation_pledges;
create policy pledges_insert on donation_pledges for insert with check (pledger_gahoi_id = current_gahoi_id());

-- Ledger पूरी तरह financial-flag/admin only — कोई member अपनी entry भी सीधे नहीं देख सकता
drop policy if exists ledger_admin_only on ledger_entries;
create policy ledger_admin_only on ledger_entries for all using (is_approver_or_admin()) with check (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- audit_log — कोई भी सीधे नहीं लिख सकता (सिर्फ़ SECURITY DEFINER functions/Edge Functions),
-- सिर्फ़ Admin पढ़ सकता है
-- ----------------------------------------------------------------------------
alter table audit_log enable row level security;

drop policy if exists audit_read_admin on audit_log;
create policy audit_read_admin on audit_log for select using (is_admin());
-- कोई insert/update/delete policy जान-बूझकर नहीं दी — सिर्फ़ service_role (Edge Function से,
-- RLS bypass करके) या एक SECURITY DEFINER function लिख सकता है

-- ----------------------------------------------------------------------------
-- ads / sponsorships
-- ----------------------------------------------------------------------------
alter table ads enable row level security;
alter table sponsorships enable row level security;

drop policy if exists ads_read_approved on ads;
create policy ads_read_approved on ads for select using (status = 'Approved' or is_admin());
drop policy if exists ads_write_admin on ads;
create policy ads_write_admin on ads for all using (is_admin()) with check (is_admin());

drop policy if exists sponsorships_read_approved on sponsorships;
create policy sponsorships_read_approved on sponsorships for select using (status = 'Approved' or is_admin());
drop policy if exists sponsorships_write_admin on sponsorships;
create policy sponsorships_write_admin on sponsorships for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- settings — Admin-only (कुछ keys जैसे siteContent शायद public-readable होनी चाहिए,
-- अभी conservative default: Admin-only, ज़रूरत पड़ने पर per-key policy बाद में refine होगी)
-- ----------------------------------------------------------------------------
alter table settings enable row level security;

drop policy if exists settings_read_admin on settings;
create policy settings_read_admin on settings for select using (is_admin());
drop policy if exists settings_write_admin on settings;
create policy settings_write_admin on settings for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- DPDP tables (भाग 9)
-- ----------------------------------------------------------------------------
alter table data_requests enable row level security;
alter table security_incidents enable row level security;
alter table privacy_documents enable row level security;

drop policy if exists data_requests_own_or_admin on data_requests;
create policy data_requests_own_or_admin on data_requests
  for select using (user_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists data_requests_insert_own on data_requests;
create policy data_requests_insert_own on data_requests
  for insert with check (user_gahoi_id = current_gahoi_id());
drop policy if exists data_requests_update_admin on data_requests;
create policy data_requests_update_admin on data_requests
  for update using (is_approver_or_admin());

drop policy if exists incidents_admin_only on security_incidents;
create policy incidents_admin_only on security_incidents for all using (is_admin()) with check (is_admin());

drop policy if exists privacy_docs_read_all on privacy_documents;
create policy privacy_docs_read_all on privacy_documents for select using (true);
drop policy if exists privacy_docs_write_admin on privacy_documents;
create policy privacy_docs_write_admin on privacy_documents for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- feedback / pending_signups
-- ----------------------------------------------------------------------------
alter table feedback enable row level security;
alter table pending_signups enable row level security;

drop policy if exists feedback_own_or_admin on feedback;
create policy feedback_own_or_admin on feedback
  for select using (submitted_by = current_gahoi_id() or is_approver_or_admin());
drop policy if exists feedback_insert on feedback;
create policy feedback_insert on feedback for insert with check (true);

drop policy if exists pending_signups_admin_only on pending_signups;
create policy pending_signups_admin_only on pending_signups for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- claim_requests, known_members वगैरह पर ऊपर पहले से cover हो चुका
-- ============================================================================
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0006_akna_list_and_constraints.sql
-- ============================================================================
-- Gahoi Portal — Migration 0006: Akna Reference List + Registration Constraints
-- (पिछली migrations में छूट गया था — मौजूदा AknaList sheet का replacement)
-- ============================================================================

create table if not exists akna_list (
  id          uuid primary key default gen_random_uuid(),
  hindi       text not null,
  english     text,
  variants    text,          -- comma/space-separated alternate spellings, search के लिए
  akna_group  text,          -- Search में "Akna Group" filter के लिए (मौजूदा doAddAkna/group जैसा)
  active      boolean not null default true,
  added_by    text,          -- gahoi_id या 'system' (initial-migration के लिए)
  added_at    timestamptz not null default now()
);

create index if not exists idx_akna_list_active on akna_list(active) where active = true;
create index if not exists idx_akna_list_english_lower on akna_list(lower(english));

alter table akna_list enable row level security;

drop policy if exists akna_list_read_all on akna_list;
create policy akna_list_read_all on akna_list for select using (true);
drop policy if exists akna_list_write_admin on akna_list;
create policy akna_list_write_admin on akna_list for all
  using (is_approver_or_admin()) with check (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- मौजूदा Code.gs में mobile की duplicate-check होती थी (m.mobile === d.mobile) —
-- अब DB-level unique constraint से भी enforce होगी (सिर्फ़ application-check काफ़ी नहीं)
-- ----------------------------------------------------------------------------
create unique index if not exists idx_persons_mobile_unique
  on persons(mobile) where mobile is not null and mobile <> '';
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0007_profile_security_and_tier.sql
-- ============================================================================
-- Gahoi Portal — Migration 0007: Self-Update Guard + Profile-Tier Auto-Calc
--
-- ⚠️ SECURITY FIX: 0005_rls_policies.sql में `persons_update_own` policy सिर्फ़
-- ROW-level check करती थी (auth_uid = auth.uid()) — इसका मतलब कोई भी अपनी row पर
-- status='Approved' या role='Admin' खुद set कर सकता था (self-approve/self-promote)!
-- ये trigger उसे रोकता है — non-admin अपने status/role/gahoi_id/auth_uid कभी नहीं
-- बदल सकता, चाहे कुछ भी भेजे।
-- ============================================================================

create or replace function protect_privileged_person_fields()
returns trigger
language plpgsql
security definer
as $$
begin
  -- Admin को कोई रोक नहीं (Admin ही approve-member Edge Function से ये बदलता है,
  -- पर SQL-स्तर पर भी Admin को block नहीं करना चाहते — service_role वैसे भी RLS bypass करता है)
  if is_admin() then
    return new;
  end if;

  -- गैर-Admin (यानी खुद अपनी row edit करने वाला सामान्य member) — ये fields हमेशा पुराने ही रहेंगे
  new.status       := old.status;
  new.role         := old.role;
  new.gahoi_id     := old.gahoi_id;
  new.auth_uid     := old.auth_uid;
  new.created_at   := old.created_at;
  new.created_by   := old.created_by;
  new.claim_status := old.claim_status;
  new.referred_by  := old.referred_by;   -- referrer registration के बाद नहीं बदल सकता

  return new;
end;
$$;

create or replace trigger trg_protect_privileged_fields
  before update on persons
  for each row execute function protect_privileged_person_fields();

-- ----------------------------------------------------------------------------
-- Profile Tier / Completion % — Auto-calculate (मौजूदा Code.gs के
-- calculateProfileCompletion() का SQL-equivalent, हर update पर खुद चलेगा,
-- user इसे मैन्युअल रूप से set नहीं कर सकता — ऊपर वाले trigger से भी अलग,
-- क्योंकि ये किसी भी update (Admin समेत) पर सही मान से fresh calculate करता है)
-- ----------------------------------------------------------------------------
create or replace function calculate_profile_tier()
returns trigger
language plpgsql
as $$
declare
  pct int := 0;
  is_married boolean;
  prof jsonb;
begin
  prof := coalesce(new.profile, '{}'::jsonb);
  is_married := lower(coalesce(new.marital,'')) in ('married','widow','widower','divorcee');

  -- Quick-signup baseline — 35%
  if new.name        is not null and new.name        <> '' then pct := pct + 5; end if;
  if new.father      is not null and new.father      <> '' then pct := pct + 5; end if;
  if new.mobile      is not null and new.mobile      <> '' then pct := pct + 5; end if;
  if new.email       is not null and new.email       <> '' then pct := pct + 5; end if;
  if new.city        is not null and new.city        <> '' then pct := pct + 5; end if;
  if new.native      is not null and new.native      <> '' then pct := pct + 5; end if;
  if new.akna        is not null and new.akna        <> '' then pct := pct + 5; end if;

  -- Silver tier — 35%
  if new.photo       is not null and new.photo       <> '' then pct := pct + 6; end if;
  if new.profession  is not null and new.profession  <> '' then pct := pct + 4; end if;
  if new.designation is not null and new.designation <> '' then pct := pct + 3; end if;
  if (new.address is not null and new.address <> '') or (prof->>'streetAddress' is not null and prof->>'streetAddress' <> '')
    then pct := pct + 6; end if;
  if new.pincode     is not null and new.pincode     <> '' then pct := pct + 3; end if;
  if new.blood_group is not null and new.blood_group <> '' then pct := pct + 3; end if;
  if new.bday        is not null and new.bday        <> '' then pct := pct + 4; end if;
  if new.marital     is not null and new.marital     <> '' then pct := pct + 3; end if;
  if (not is_married) or (new.spouse is not null and new.spouse <> '') then pct := pct + 3; end if;

  -- Gold tier — 30%
  if (not is_married) or (new.anni is not null and new.anni <> '') then pct := pct + 3; end if;
  if new.keywords is not null and array_length(new.keywords,1) > 0 then pct := pct + 4; end if;
  if prof->>'bio' is not null and prof->>'bio' <> '' then pct := pct + 5; end if;
  if (prof->>'linkedin' is not null and prof->>'linkedin' <> '')
     or (prof->>'twitter' is not null and prof->>'twitter' <> '')
     or (prof->>'instagram' is not null and prof->>'instagram' <> '')
     or (prof->>'facebook' is not null and prof->>'facebook' <> '')
    then pct := pct + 6; end if;
  if prof->>'hobbies' is not null and prof->>'hobbies' <> '' then pct := pct + 4; end if;
  if prof->>'school' is not null and prof->>'school' <> '' then pct := pct + 3; end if;
  if new.public_url_enabled is not null then pct := pct + 2; end if;
  if new.privacy_settings is not null and new.privacy_settings <> '{}'::jsonb then pct := pct + 3; end if;

  pct := least(pct, 100);
  new.completion_percent := pct;
  new.profile_tier := case when pct >= 80 then 'Gold' when pct >= 50 then 'Silver' else 'Bronze' end;

  return new;
end;
$$;

-- ज़रूरी: पहले privileged-fields-protect चले, फिर tier-calculate (alphabetical trigger-order से
-- naming prefix "a_"/"b_" से control करना ज़्यादा भरोसेमंद है Postgres में)
drop trigger if exists trg_protect_privileged_fields on persons;
create or replace trigger a_protect_privileged_fields
  before update on persons
  for each row execute function protect_privileged_person_fields();

create or replace trigger b_calculate_profile_tier
  before insert or update on persons
  for each row execute function calculate_profile_tier();
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0008_persons_approval_fields.sql
-- ============================================================================
-- Gahoi Portal — Migration 0008: Missing Persons Fields (approved_by/approved_at)
-- मौजूदा Code.gs के Members sheet में ApprovedBy/ApprovedAt columns थे — नए schema
-- में छूट गए थे, GR के "check input fields" पर पकड़ में आया।
-- ============================================================================

alter table persons add column if not exists approved_by text;      -- gahoi_id जिसने approve किया
alter table persons add column if not exists approved_at timestamptz;

-- approve-member Edge Function अब इन्हें भरेगा — trigger में इन्हें protect करने की
-- ज़रूरत नहीं (सिर्फ़ Admin/Approver ही status बदल सकते हैं, वही इन्हें भी सेट करेंगे,
-- migration 0007 का protect_privileged_person_fields() पहले से गैर-Admin को status
-- बदलने से रोकता है इसलिए approved_by/at भी उसी सुरक्षा-घेरे में स्वाभाविक रूप से आ जाता है
-- — फिर भी स्पष्टता के लिए trigger में explicit जोड़ते हैं)

create or replace function protect_privileged_person_fields()
returns trigger
language plpgsql
security definer
as $$
begin
  if is_admin() then
    return new;
  end if;

  new.status       := old.status;
  new.role         := old.role;
  new.gahoi_id     := old.gahoi_id;
  new.auth_uid     := old.auth_uid;
  new.created_at   := old.created_at;
  new.created_by   := old.created_by;
  new.claim_status := old.claim_status;
  new.referred_by  := old.referred_by;
  new.approved_by  := old.approved_by;    -- नया — गैर-Admin खुद को approve-mark नहीं कर सकता
  new.approved_at  := old.approved_at;    -- नया

  return new;
end;
$$;
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0009_fix_service_role_privileged_fields.sql
-- ============================================================================
-- Gahoi Portal — Migration 0009: Fix service_role bypass in privileged-fields trigger
--
-- 🐛 GENUINE BUG FOUND (और यहीं ठीक किया गया — verified on real local Postgres 16,
--    not just written and assumed correct — देखें नीचे "Verification" नोट):
--
-- `protect_privileged_person_fields()` (migration 0007, फिर 0008 में re-defined)
-- सिर्फ़ `is_admin()` के true होने पर status/role/gahoi_id/auth_uid/approved_by/at
-- वगैरह को बदलने देता है। `is_admin()` अंदर से `auth.uid()` पढ़ता है — जो सिर्फ़ तब
-- कुछ return करता है जब request का JWT किसी असली logged-in user का हो।
--
-- लेकिन `approve-member` Edge Function (और अब नया `admin-edit-member` /
-- `admin-set-role`, भाग 8 का अगला कदम) SERVICE_ROLE_KEY से Postgres से बात करता
-- है — उस connection में कोई end-user JWT नहीं होता, इसलिए `auth.uid()` = NULL,
-- और `is_admin()` = **false**, भले ही Edge Function ने अपने JS code में पहले ही
-- caller का Admin/Approver role verify कर लिया हो।
--
-- नतीजा: `approve-member` का `status='Approved'` वाला update trigger द्वारा
-- **चुपचाप वापस पुरानी value (Pending) पर पलट दिया जाता था** — यानी असली
-- Postgres पर Admin के "Approve" बटन दबाने पर सदस्य असल में कभी Approved नहीं
-- होता था, हालाँकि Edge Function ख़ुद success:true लौटाता (क्योंकि update-query
-- ख़ुद error नहीं देती, बस row को silently unchanged छोड़ती है)।
--
-- Fix: trigger अब `auth.role() = 'service_role'` को भी `is_admin()` जितना ही
-- भरोसा करता है — service_role वैसे भी RLS पूरी तरह bypass करता है (यानी वो पहले
-- से ही एक trusted-server context है), और हर Edge Function जो service_role
-- इस्तेमाल करता है वो caller का Admin/Approver role अपने JS code में पहले ही
-- verify कर चुका होता है (approve-member, admin-edit-member, admin-set-role
-- सबका पैटर्न यही है) — इसलिए trigger-level पर दोबारा रोकना ग़लत था।
--
-- ⚠️ Verification (असली, sandbox में की गई — सिर्फ़ code-review नहीं):
-- Postgres 16 install करके, auth.uid()/auth.role() के असली Supabase-जैसे
-- definitions (request.jwt.claim.sub/role GUC से) बनाकर, तीन scenario टेस्ट
-- किए गए:
--   A. असली Admin session (सीधे supabase-js client से, जैसे नया `admin-members.html`
--      करेगा profile-edit के लिए) — पहले भी काम करता था, फिर भी काम करता है ✅
--   B. service_role key (Edge Function pattern, जैसे approve-member) —
--      पहले चुपचाप update वापस पलट देता था (BUG) → fix के बाद सही से Approve
--      होता है ✅
--   C. एक non-Admin member ख़ुद को directly (JWT से, बिना Edge Function के)
--      Approve/Admin बनाने की कोशिश करे — fix के बाद भी सही से blocked रहता है
--      (मूल security-fix का मक़सद बरक़रार) ✅
-- ============================================================================

create or replace function protect_privileged_person_fields()
returns trigger
language plpgsql
security definer
as $$
begin
  if is_admin() or auth.role() = 'service_role' then
    return new;
  end if;

  new.status       := old.status;
  new.role         := old.role;
  new.gahoi_id     := old.gahoi_id;
  new.auth_uid     := old.auth_uid;
  new.created_at   := old.created_at;
  new.created_by   := old.created_by;
  new.claim_status := old.claim_status;
  new.referred_by  := old.referred_by;
  new.approved_by  := old.approved_by;
  new.approved_at  := old.approved_at;

  return new;
end;
$$;
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0010_extend_panchayat_memberships.sql
-- ============================================================================
-- Gahoi Portal — Migration 0010: Extend panchayat_memberships for Mahasabha
--
-- 🔎 Migration-script लिखते वक़्त मिली एक असली architecture-gap (सिर्फ़ code-review
-- से, migrate-mahasabha.js शुरू करने से पहले पकड़ी गई):
--
-- पुरानी MahasabhaMembers Google Sheet (32 columns — देखें legacy-quirks.md का
-- "Mahasabha MSM sheet schema") में ये सब भी था जो नए `panchayat_memberships`
-- table में कहीं नहीं है:
--   Panchayat, KshetriyaPanchayat, FatherOrHusband, Vyavsay, Shiksha, DOB,
--   PaymentMode, TransactionRef, TransactionDate, RejectedReason,
--   PaymentReceived/By/At, PaymentForwarded/By/At, FormSubmitted/By/At, Remarks
--
-- मौजूदा gahoi-portal.md memory के अनुसार ये सिर्फ़ archival data नहीं है — Admin
-- का 4-step pipeline (approve → payReceived → payForwarded → formSubmitted) इन्हीं
-- fields पर चलता है, यानी बिना इन्हें जोड़े migrate-mahasabha.js या तो data चुपचाप
-- खो देता या insert ही fail हो जाता।
--
-- Fix: दो हिस्सों में —
--   1. जो fields अभी भी सक्रिय workflow-state हैं (payment/form steps) — पहले
--      class के columns, ताकि आगे Admin Panel उन पर सीधे index/filter कर सके
--      (जैसे persons.status पहले से column है, jsonb के अंदर नहीं)
--   2. बाक़ी सब (Panchayat/Kshetriya text, Vyavsay, Shiksha, DOB, payment-mode/ref,
--      rejected-reason, remarks) — एक `form_data jsonb` column में, बिल्कुल
--      `persons.profile` jsonb वाले pattern जैसा (भाग 9 का established convention)
-- ============================================================================

alter table panchayat_memberships
  add column if not exists form_data jsonb not null default '{}'::jsonb,
  -- { panchayat, kshetra, fatherOrHusband, vyavsay, shiksha, dob, paymentMode,
  --   transactionRef, transactionDate, rejectedReason, remarks, fullFormData }

  add column if not exists payment_received      boolean not null default false,
  add column if not exists payment_received_by   text,
  add column if not exists payment_received_at   timestamptz,

  add column if not exists payment_forwarded     boolean not null default false,
  add column if not exists payment_forwarded_by  text,
  add column if not exists payment_forwarded_at  timestamptz,

  add column if not exists form_submitted        boolean not null default false,
  add column if not exists form_submitted_by     text,
  add column if not exists form_submitted_at     timestamptz,

  -- legacy MahasabhaMembers.ApprovedAt — approved_by तो पहले से column था,
  -- approved_at भूल से छूट गया था पहले draft में, migrate-mahasabha.js लिखते
  -- वक़्त पकड़ा गया
  add column if not exists approved_at           timestamptz;
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0011_add_offers_table.sql
-- ============================================================================
-- Gahoi Portal — Migration 0011: Add missing `offers` table
--
-- 🔎 migrate-offers.js लिखने से पहले मिला gap — legacy Code.gs में "Current
-- Offers" का पूरा module है (doGetOffer, doGetOffers, doPostOffer, doDeleteOffer
-- — Offers sheet: ID/PostedBy/Title/Details/Image/Cities/Mobile/ValidTill/
-- Posted/DeletedAt), पर migration 0002/0003 में इसका Postgres table कभी बना ही
-- नहीं गया (business_listings/jobs/gallery/dharmshala/magazines सब बने, offers
-- छूट गया)। README में पहले ग़लती से "schema पहले से है" लिख दिया गया था —
-- असल data-export (Gahoi_Portal.xlsx की Offers sheet, 1 row) migrate करने बैठे
-- तो पता चला कि table ही नहीं है।
--
-- business_listings जैसा ही pattern — owner/admin लिख सकते हैं, सब पढ़ सकते हैं
-- (delete नहीं हुआ हो तो), legacy का ValidTill auto-expiry भी साथ रखा गया।
-- ============================================================================

create table if not exists offers (
  id           uuid primary key default gen_random_uuid(),
  posted_by    text references persons(gahoi_id),
  title        text,
  details      text,
  image        text,
  cities       text,
  mobile       text,
  valid_till   date,
  posted_at    timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   text
);

create index if not exists idx_offers_valid_till on offers(valid_till) where deleted_at is null;

alter table offers enable row level security;

-- legacy doGetOffers() ValidTill बीत जाने पर auto soft-delete करता था — यहाँ
-- read-time पर ही expiry भी check कर लेते हैं ताकि किसी अलग cron/trigger की
-- ज़रूरत ना पड़े (deleted_at अलग से भी set किया जा सकता है, दोनों शर्तें OR हैं)
drop policy if exists offers_read_all on offers;
create policy offers_read_all on offers for select
  using (deleted_at is null and (valid_till is null or valid_till >= current_date));

drop policy if exists offers_write_own_or_admin on offers;
create policy offers_write_own_or_admin on offers for all
  using (posted_by = current_gahoi_id() or is_approver_or_admin())
  with check (posted_by = current_gahoi_id() or is_approver_or_admin());
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0012_public_config_and_secrets.sql
-- ============================================================================
-- Gahoi Portal — Migration 0012: Public config + secrets via existing `settings` table
--
-- GR चाहते हैं Cloudinary/Razorpay/Resend जैसी हर चीज़ website (Admin Settings
-- page) से configure हो, code में hardcode ना हो।
--
-- ⚠️ पहले draft में इसके लिए दो नई tables (app_settings/app_secrets) बना दी
-- गई थीं — फिर पता चला कि migration 0003 में इसी मक़सद के लिए **पहले से एक
-- `settings` table (doc_id/data jsonb) डिज़ाइन की जा चुकी थी**
-- (matrimony/daanSeva/paymentAccounts/siteContent/legalPages/notifications/
-- trustInfo जैसे doc_ids का ज़िक्र मूल कमेंट में ही था)। दो parallel config-
-- systems बनाना confusion और bugs का पक्का रास्ता है — इसलिए वो पहला migration
-- हटाकर यह एक ही, मौजूदा table को extend करने वाला migration बनाया गया।
--
-- मौजूदा RLS (0005) सिर्फ़ यह करती थी: `is_admin()` — यानी हर doc सिर्फ़ Admin
-- पढ़/लिख सकता था। पर Cloudinary cloud-name, Razorpay Key ID जैसी publishable
-- values को हर browser-tab को (बिना login के भी, जैसे register.html पर फ़ोटो
-- अपलोड) पढ़ना होता है — इसलिए एक `doc_id = 'publicConfig'` के लिए खुली
-- select-policy जोड़ी गई। और असली secrets (API secret keys) को Admin के अपने
-- browser session से भी सीधे पढ़ने से रोकने के लिए `doc_id = 'secrets'` को
-- मौजूदा admin-select-policy से explicitly बाहर रखा गया — सिर्फ़ service_role
-- (Edge Functions, BYPASSRLS) उसे पढ़/लिख सकता है, बिल्कुल audit_log जैसा
-- pattern।
--
-- कोई भी direct client-side WRITE किसी भी doc पर नहीं — audit-logging ज़रूरी
-- है (admin-update-settings Edge Function से ही, admin-edit-member/
-- admin-set-role जैसा pattern), इसलिए पुरानी settings_write_admin policy भी
-- हटा दी गई।
-- ============================================================================

drop policy if exists settings_read_admin on settings;
drop policy if exists settings_write_admin on settings;

-- publicConfig doc — कोई भी (anon समेत) पढ़ सकता है
drop policy if exists settings_read_public on settings;
create policy settings_read_public on settings
  for select using (doc_id = 'publicConfig');

-- बाक़ी सब doc — सिर्फ़ Admin/Approver, पर 'secrets' doc कभी नहीं (चाहे Admin ही क्यों ना हो)
drop policy if exists settings_read_admin on settings;
create policy settings_read_admin on settings
  for select using (doc_id <> 'secrets' and is_approver_or_admin());

-- कोई client-side insert/update/delete policy नहीं — हर write admin-update-settings
-- Edge Function (service_role) से ही होगी

-- ── शुरुआती डिफ़ॉल्ट docs — GR Admin Settings page से इन्हें भरेंगे ──────────
insert into settings (doc_id, data) values
  ('publicConfig', jsonb_build_object(
    'portalName', 'गहोई पोर्टल',
    'portalUrl', 'https://jaigahoi.in',
    'supportEmail', 'gahoi.portal@gmail.com',
    'supportWhatsapp', '',
    'cloudinaryCloudName', '',
    'cloudinaryUploadPreset', '',
    'razorpayKeyId', ''
  )),
  ('emailConfig', jsonb_build_object(
    'resendFromEmail', '',
    'resendFromName', 'Gahoi Portal'
  )),
  ('appConfig', jsonb_build_object(
    'mahasabhaFee', 100,
    'maxApprovers', 10
  )),
  -- असली secrets — value हमेशा खाली शुरू होती है, GR Admin Settings page से भरेंगे।
  -- खाली होने पर Edge Functions Deno.env.get() fallback इस्तेमाल करती हैं
  -- (देखें _shared/settings.ts) ताकि deploy के फ़ौरन बाद भी कुछ ना टूटे।
  ('secrets', jsonb_build_object(
    'cloudinaryApiKey', '',
    'cloudinaryApiSecret', '',
    'resendApiKey', '',
    'razorpayKeySecret', ''
  ))
on conflict (doc_id) do nothing;
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0013_messaging_space_daan_helpers.sql
-- ============================================================================
-- Gahoi Portal — Migration 0013: Messaging + Gahoi Space + Daan Seva helpers
--
-- तीनों नए frontend flows (messages.html, space.html, donate.html) बनाते वक़्त
-- कुछ operations ऐसे मिले जिन्हें client-side "पढ़ो-फिर-लिखो" (read-modify-write)
-- से करना race-condition-prone होता — दो अलग tabs/requests एक साथ चलें तो एक
-- update गुम हो सकता है। इसलिए ये SECURITY DEFINER Postgres functions, जो
-- atomic रूप से (एक ही SQL statement में) काम करते हैं।
-- ============================================================================

-- ── 1. Daan Seva: campaign की raised_amount बढ़ाना ────────────────────────────
-- razorpay-verify-payment के donation-case से बुलाया जाता है। सीधे
-- `update donation_campaigns set raised_amount = raised_amount + X` भी
-- लगभग atomic ही होता (Postgres का UPDATE अपने-आप row-lock लेता है), पर एक
-- named function रखने से भविष्य में validation/notification जोड़ना आसान रहता
-- है, और Edge Function का code साफ़ रहता है।
create or replace function increment_campaign_raised(p_campaign_id uuid, p_amount numeric)
returns void
language sql
security definer
as $$
  update donation_campaigns
  set raised_amount = coalesce(raised_amount, 0) + p_amount
  where id = p_campaign_id;
$$;

-- ── 2. Messaging: दो लोगों के बीच conversation ढूँढना/बनाना ──────────────────
-- `conversations` पर unique(participant_a, participant_b) है, पर participant_a
-- कौन है participant_b कौन — यह तय ना हो तो एक ही जोड़ी के लिए दो अलग-अलग rows
-- (A,B) और (B,A) बन सकती हैं। यह function हमेशा एक तय क्रम (छोटा gahoi_id पहले)
-- में insert करता है, और `on conflict do nothing` + फिर select से race-safe
-- तरीक़े से handle करता है (दो लोग एक साथ पहला message भेजें तो भी सिर्फ़ एक ही
-- conversation बनेगी)।
create or replace function get_or_create_conversation(p_other_gahoi_id text)
returns uuid
language plpgsql
security definer
as $$
declare
  v_me text := current_gahoi_id();
  v_a text;
  v_b text;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;
  if v_me = p_other_gahoi_id then
    raise exception 'Cannot message yourself';
  end if;

  if v_me < p_other_gahoi_id then
    v_a := v_me; v_b := p_other_gahoi_id;
  else
    v_a := p_other_gahoi_id; v_b := v_me;
  end if;

  insert into conversations (participant_a, participant_b)
  values (v_a, v_b)
  on conflict (participant_a, participant_b) do nothing;

  select id into v_id from conversations where participant_a = v_a and participant_b = v_b;
  return v_id;
end;
$$;

-- ── 3. Gahoi Space: like/unlike toggle ────────────────────────────────────────
-- legacy Code.gs के doToggleSpaceLike() जैसा — liked_by text[] array में
-- current_gahoi_id() को add/remove करता है, atomically (कोई दो client एक साथ
-- like करें तो भी count सही रहे)।
create or replace function toggle_space_like(p_post_id uuid)
returns table(liked boolean, like_count int)
language plpgsql
security definer
as $$
declare
  v_me text := current_gahoi_id();
  v_already boolean;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;

  select v_me = any(liked_by) into v_already from space_posts where id = p_post_id;
  if v_already is null then
    raise exception 'Post not found';
  end if;

  if v_already then
    update space_posts set liked_by = array_remove(liked_by, v_me) where id = p_post_id;
  else
    update space_posts set liked_by = array_append(liked_by, v_me) where id = p_post_id;
  end if;

  return query select not v_already, coalesce(array_length(sp.liked_by, 1), 0) from space_posts sp where sp.id = p_post_id;
end;
$$;

-- ── 4. Gahoi Space: comment_count हमेशा सही रहे — trigger से ─────────────────
-- (client से manually increment/decrement करवाना भूलने-योग्य और race-prone
-- दोनों है — insert/soft-delete पर अपने-आप हो जाए तो बेहतर)
create or replace function sync_space_comment_count()
returns trigger
language plpgsql
security definer
as $$
begin
  if TG_OP = 'INSERT' then
    update space_posts set comment_count = coalesce(comment_count, 0) + 1 where id = new.post_id;
  elsif TG_OP = 'UPDATE' and old.status = 'Active' and new.status = 'Deleted' then
    update space_posts set comment_count = greatest(coalesce(comment_count, 1) - 1, 0) where id = new.post_id;
  elsif TG_OP = 'UPDATE' and old.status = 'Deleted' and new.status = 'Active' then
    update space_posts set comment_count = coalesce(comment_count, 0) + 1 where id = new.post_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_space_comment_count on space_comments;
create or replace trigger trg_sync_space_comment_count
  after insert or update on space_comments
  for each row execute function sync_space_comment_count();
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0014_settings_public_read.sql
-- ============================================================================
-- Gahoi Portal — Migration 0014: appConfig publicly readable (Mahasabha fee)
--
-- 🔎 mahasabha.html (member-facing application page) बनाते वक़्त मिली असली gap:
-- appConfig doc (mahasabhaFee, maxApprovers) की RLS policy सिर्फ़ is_approver_or_
-- admin() को पढ़ने देती थी (migration 0012)। मतलब कोई साधारण member अपनी
-- Mahasabha application भरने से पहले यह देख ही नहीं सकता था कि fee कितनी है —
-- या तो JS में हार्डकोड करना पड़ता (जो admin के settings बदलने पर चुपचाप ग़लत
-- हो जाता) या fee पूछे बिना ही payment शुरू करनी पड़ती।
--
-- Fix: 'secrets' के अलावा हर doc अब सबको (anon समेत) पढ़ने देते हैं — publicConfig
-- पहले से public थी, अब appConfig/emailConfig भी। इनमें कोई भी असली गुप्त value
-- नहीं है (API keys/secrets हमेशा से अलग 'secrets' doc में हैं, service_role-only,
-- यह migration उसे बिल्कुल नहीं छूती)। maxApprovers/emailConfig का सार्वजनिक होना
-- हानिरहित है — कोई sensitive data नहीं, सिर्फ़ operational config।
-- ============================================================================

drop policy if exists settings_read_public on settings;
drop policy if exists settings_read_admin on settings;

-- 'secrets' doc हमेशा service_role-only रहेगा (कोई client policy नहीं इसे कवर
-- करेगी — ना यह, ना कोई और) — बाक़ी हर doc अब सबको पढ़ने देते हैं।
drop policy if exists settings_read_public on settings;
create policy settings_read_public on settings
  for select using (doc_id <> 'secrets');

-- कोई client-side insert/update/delete policy अब भी नहीं — हर write अब भी सिर्फ़
-- admin-update-settings Edge Function (service_role) से ही होगी, migration 0012 जैसा।
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0015_feature_flags.sql
-- ============================================================================
-- Gahoi Portal — Migration 0015: featureFlags settings doc
--
-- GR की standing requirement (2026-09-25): Admin को हर feature/page/payment
-- option ऑन-ऑफ करने का पूरा अधिकार होना चाहिए, और बंद होने पर member को एक
-- साफ़ message/popup दिखे — कोई silent 404/broken-page अनुभव ना हो।
--
-- Design: मौजूदा settings table (doc_id/data jsonb) pattern ही दोहराया —
-- नया table नहीं बनाया, migration 0012 वाला convention जारी रखा। 'secrets'
-- के अलावा हर doc migration 0014 से पहले ही publicly readable है, तो
-- featureFlags अपने-आप हर सदस्य (और anon) को दिखेगी बिना किसी नई RLS policy के।
-- ============================================================================

insert into settings (doc_id, data) values
  ('featureFlags', jsonb_build_object(
    -- सबसे पहले से मौजूद pages (retrofit, 2026-09-26 — GR की "admin को हर
    -- feature/page पर पूरा अधिकार" वाली requirement पुरानी pages पर भी लागू)
    'businessEnabled', true,
    'directoryEnabled', true,
    'jobsEnabled', true,
    'matrimonyEnabled', true,
    'messagesEnabled', true,
    'spaceEnabled', true,
    -- इस session में built नई pages (default: true, यानी सब चालू)
    'eventsEnabled', true,
    'galleryEnabled', true,
    'offersEnabled', true,
    'magazinesEnabled', true,
    'dharmshalaEnabled', true,
    'mahasabhaEnabled', true,
    'knownMembersEnabled', true,
    'referralsEnabled', true,
    'daanSevaEnabled', true,
    -- payment options अलग से — feature ही चालू रहे पर सिर्फ़ online payment
    -- बंद करनी हो (जैसे "Razorpay keys issue, paused" — gahoi-portal.md में
    -- पहले से नोट किया मामला) तो feature दिखेगा, बस "Pay Now" button छुप जाएगा
    'mahasabhaOnlinePaymentEnabled', true,
    'donationOnlinePaymentEnabled', true,
    -- सामान्य maintenance-mode जैसा उपयोग — पूरे portal के लिए (अभी सिर्फ़ flag,
    -- असल में लागू करना frontend/common.js का काम है, अलग से)
    'portalMaintenanceMode', false,
    'portalMaintenanceMessage', ''
  ))
on conflict (doc_id) do nothing;
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0016_mahasabha_print_role.sql
-- ============================================================================
-- Gahoi Portal — Migration 0016: mahasabhaPrint role access to panchayat_memberships
--
-- 🔎 admin-mahasabha.html बनाते वक़्त मिला gap: admin-members.html अब भी "mahasabhaPrint"
-- role assign करने देता है (legacy Code.gs का तीसरा भूमिका — Admin/Approver/
-- mahasabhaPrint तीनों को Mahasabha access देता था), पर is_approver_or_admin()
-- (migration 0005) सिर्फ़ Admin/Approver जानता है — mahasabhaPrint को कहीं कोई
-- RLS grant नहीं मिलता था।
--
-- Fix scope: is_approver_or_admin() खुद बदलना बहुत बड़ा blast-radius होता (वो
-- function कई अलग-अलग tables पर इस्तेमाल होता है) — इसलिए यहाँ सिर्फ़
-- panchayat_memberships पर एक अलग, targeted policy जोड़ रहे हैं जो mahasabhaPrint
-- को भी select+update करने दे। किसी और table पर कोई असर नहीं।
-- ============================================================================

drop policy if exists pm_select_mahasabha_print on panchayat_memberships;
create policy pm_select_mahasabha_print on panchayat_memberships
  for select using (coalesce(current_person_role() = 'mahasabhaPrint', false));

drop policy if exists pm_update_mahasabha_print on panchayat_memberships;
create policy pm_update_mahasabha_print on panchayat_memberships
  for update using (coalesce(current_person_role() = 'mahasabhaPrint', false));
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0017_panchang_festivals.sql
-- ============================================================================
-- Gahoi Portal — Migration 0017: Panchang + Festivals
-- Legacy Code.gs (Panchang V5 / Festivals V2) ke Sheets ko Postgres tables se
-- replace karta hai. Data GAS cron likhta hai (service key se), portal sirf
-- padhta hai — isliye yahan sirf SELECT policy hai, koi write policy nahi.
-- ============================================================================

create table if not exists panchang_daily (
  date        date primary key,
  tithi       text, nakshatra text, yoga text, karana text,
  paksha      text, amanta text, purnimanta text, samvat text,
  sunrise     text, sunset text, festival text,
  fetched_at  timestamptz not null default now()
);

create table if not exists festivals (
  id          bigserial primary key,
  date        date not null,
  name        text not null,
  hindi       text,
  emoji       text default '🎉',
  category    text default 'Hindu',
  fetched_at  timestamptz not null default now(),
  unique (date, name)
);
create index if not exists festivals_date_idx on festivals (date);

alter table panchang_daily enable row level security;
alter table festivals enable row level security;

drop policy if exists panchang_select_all on panchang_daily;
create policy panchang_select_all on panchang_daily for select to anon, authenticated using (true);

drop policy if exists festivals_select_all on festivals;
create policy festivals_select_all on festivals for select to anon, authenticated using (true);
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0018_mahasabha_parity.sql
-- ============================================================================
-- Gahoi Portal — Migration 0018: Mahasabha parity (legacy doResetMahasabhaApplication)
-- Legacy mein Admin kisi member ki application "reset" kar sakta tha (row delete +
-- member ka mahasabha status clear) taaki wo dobara apply kar sake. v2 mein
-- panchayat_memberships par DELETE policy hi nahi thi — sirf Admin ko yahin grant.
-- Baaki naye fields (mool, address, photo, signature, printedAt, ...) form_data
-- jsonb mein jaate hain, isliye koi nayi column nahi chahiye.
-- ============================================================================
drop policy if exists pm_delete_admin on panchayat_memberships;
create policy pm_delete_admin on panchayat_memberships
  for delete using (coalesce(is_admin(), false));
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\migrations\0019_professional_tags.sql
-- ============================================================================
-- Gahoi Portal — Migration 0019: Samaj ke logon ke Professional / Public-life tags
-- (Doctor, Engineer, Advocate, CA, Politician, ... — registered members AUR census entries)
--
-- Design:
--  * profession_categories : admin-editable taxonomy (seed neeche). `sensitive` = true wali
--    category (Politician) ka tag tabhi doosron ko dikhta hai jab us person ne KHUD confirm kiya ho
--    (DPDP: political affiliation sensitive; census entry confirm kar hi nahi sakta => admin-only rehta hai).
--  * person_professions    : ek person ke kai tags. Direct SELECT sirf owner/admin ko; baaki sab
--    search_professionals() RPC se (sirf safe columns — mobile/email/address kabhi nahi).
--  * person_profession_private : registration no. / proof — sirf owner + Admin/Approver.
--  * Verification: unverified -> pending -> verified/rejected; sirf Admin/Approver badal sakte hain.
-- ============================================================================

create table if not exists profession_categories (
  slug        text primary key,
  label_hi    text not null,
  label_en    text not null,
  group_key   text not null default 'other',
  icon        text default '🏷',
  sensitive   boolean not null default false,
  sort_order  int not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into profession_categories (slug, label_hi, label_en, group_key, icon, sensitive, sort_order) values
  ('doctor',       'डॉक्टर (MBBS/MD/MS)',          'Doctor',                    'medical',  '🩺', false, 10),
  ('dentist',      'दंत चिकित्सक',                  'Dentist',                   'medical',  '🦷', false, 11),
  ('ayush',        'वैद्य / आयुष (आयुर्वेद/होम्योपैथी)', 'AYUSH Practitioner',          'medical',  '🌿', false, 12),
  ('pharmacist',   'फार्मासिस्ट',                    'Pharmacist',                'medical',  '💊', false, 13),
  ('engineer',     'इंजीनियर',                      'Engineer',                  'engineering','🛠', false, 20),
  ('architect',    'आर्किटेक्ट',                     'Architect',                 'engineering','📐', false, 21),
  ('advocate',     'अधिवक्ता (वकील)',                'Advocate',                  'legal',    '⚖️', false, 30),
  ('judiciary',    'न्यायिक सेवा',                   'Judiciary',                 'legal',    '🏛', false, 31),
  ('ca',           'चार्टर्ड अकाउंटेंट (CA)',         'Chartered Accountant',      'finance',  '📊', false, 40),
  ('cs_cma',       'कंपनी सेक्रेटरी / CMA',          'Company Secretary / CMA',   'finance',  '📑', false, 41),
  ('banker',       'बैंकिंग / बीमा',                 'Banking / Insurance',       'finance',  '🏦', false, 42),
  ('teacher',      'शिक्षक / प्रोफ़ेसर',              'Teacher / Professor',       'education','🎓', false, 50),
  ('researcher',   'वैज्ञानिक / शोधकर्ता',            'Scientist / Researcher',    'education','🔬', false, 51),
  ('govt_officer', 'सरकारी अधिकारी (IAS/IPS/PCS आदि)', 'Government Officer',        'government','🏢', false, 60),
  ('police_defence','पुलिस / सेना / अर्धसैनिक',        'Police / Defence',          'government','🎖', false, 61),
  ('politician',   'राजनीति / जनप्रतिनिधि',          'Politician / Public Representative','public','🗳', true, 70),
  ('social_worker','समाजसेवी',                       'Social Worker',             'public',   '🤝', false, 71),
  ('businessman',  'व्यवसायी / उद्योगपति',            'Businessman / Industrialist','business','💼', false, 80),
  ('it_professional','IT / सॉफ़्टवेयर',               'IT / Software',             'technology','💻', false, 90),
  ('media_arts',   'पत्रकार / कलाकार / खिलाड़ी',       'Media / Arts / Sports',     'media',    '🎭', false, 100),
  ('farmer',       'किसान / कृषि',                   'Farmer / Agriculture',      'agriculture','🌾', false, 110),
  ('religious',    'पंडित / ज्योतिष / धर्माचार्य',     'Priest / Astrologer / Religious','religious','🕉', false, 120),
  ('other',        'अन्य',                          'Other',                     'other',    '🏷', false, 999)
on conflict (slug) do nothing;

create table if not exists person_professions (
  id                  uuid primary key default gen_random_uuid(),
  person_gahoi_id     text not null references persons(gahoi_id) on delete cascade,
  category_slug       text not null references profession_categories(slug),
  title               text,            -- Cardiologist / Civil Engineer / Sarpanch / MLA ...
  organization        text,
  specialization      text,
  qualification       text,
  city                text,
  details             jsonb not null default '{}'::jsonb,   -- politician: {party, office, level, area, since}
  visibility          text not null default 'members' check (visibility in ('members','public','hidden')),
  source              text not null default 'self' check (source in ('self','coordinator','admin','auto-migration')),
  member_confirmed    boolean not null default false,
  verification_status text not null default 'unverified' check (verification_status in ('unverified','pending','verified','rejected')),
  verified_by         text,
  verified_at         timestamptz,
  verification_note   text,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create unique index if not exists uq_person_prof_active
  on person_professions (person_gahoi_id, category_slug, coalesce(lower(title), ''))
  where deleted_at is null;
create index if not exists idx_pp_category on person_professions (category_slug) where deleted_at is null;
create index if not exists idx_pp_person   on person_professions (person_gahoi_id) where deleted_at is null;
create index if not exists idx_pp_status   on person_professions (verification_status) where deleted_at is null;

create table if not exists person_profession_private (
  profession_id uuid primary key references person_professions(id) on delete cascade,
  reg_no        text,       -- Medical Council / Bar Council / ICAI membership no.
  proof_url     text
);

-- ───────── Triggers ─────────
create or replace function pp_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_me   text := current_gahoi_id();
  v_priv boolean := coalesce(is_approver_or_admin(), false);
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null then            -- SQL editor / service key / migration script: values jaisi di gayi waisi
      return new;
    end if;
    if new.person_gahoi_id = v_me then
      new.source := 'self'; new.member_confirmed := true;
    else
      if not v_priv then raise exception 'Not allowed to tag this person'; end if;
      new.source := case when coalesce(new.source,'') = 'coordinator' then 'coordinator' else 'admin' end;
      new.member_confirmed := false;
    end if;
    new.created_by := v_me;
    if not v_priv then new.verification_status := 'unverified'; new.verified_by := null; new.verified_at := null; end if;
    return new;
  end if;

  -- UPDATE
  new.updated_at := now();
  if auth.uid() is null then return new; end if;
  if not v_priv then
    new.person_gahoi_id := old.person_gahoi_id;
    new.source := old.source; new.created_by := old.created_by;
    new.verified_by := old.verified_by; new.verified_at := old.verified_at; new.verification_note := old.verification_note;
    -- owner sirf ye transitions kar sakta hai: unverified/rejected -> pending (verification maange); baaki status same
    if new.verification_status is distinct from old.verification_status
       and not (new.verification_status = 'pending' and old.verification_status in ('unverified','rejected')) then
      new.verification_status := old.verification_status;
    end if;
    -- owner sirf apna confirm kar sakta hai
    if old.person_gahoi_id <> v_me then raise exception 'Not your tag'; end if;
    -- verified tag ka asli content badle to dobara verify karwana padega
    if old.verification_status = 'verified'
       and (new.category_slug is distinct from old.category_slug or new.title is distinct from old.title or new.organization is distinct from old.organization) then
      new.verification_status := 'unverified'; new.verified_by := null; new.verified_at := null;
    end if;
  else
    if new.verification_status = 'verified' and old.verification_status <> 'verified' then
      new.verified_by := v_me; new.verified_at := now();
    elsif new.verification_status <> 'verified' and old.verification_status = 'verified' then
      new.verified_by := null; new.verified_at := null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_pp_before_write on person_professions;
create trigger trg_pp_before_write before insert or update on person_professions
  for each row execute function pp_before_write();

-- ───────── RLS ─────────
alter table profession_categories      enable row level security;
alter table person_professions         enable row level security;
alter table person_profession_private  enable row level security;

drop policy if exists pc_read   on profession_categories;
create policy pc_read  on profession_categories for select to anon, authenticated using (true);
drop policy if exists pc_write  on profession_categories;
create policy pc_write on profession_categories for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists pp_select on person_professions;
create policy pp_select on person_professions for select to authenticated
  using (person_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists pp_insert on person_professions;
create policy pp_insert on person_professions for insert to authenticated
  with check (person_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists pp_update on person_professions;
create policy pp_update on person_professions for update to authenticated
  using (person_gahoi_id = current_gahoi_id() or is_approver_or_admin())
  with check (person_gahoi_id = current_gahoi_id() or is_approver_or_admin());
drop policy if exists pp_delete on person_professions;
create policy pp_delete on person_professions for delete to authenticated using (is_admin());

drop policy if exists ppp_all on person_profession_private;
create policy ppp_all on person_profession_private for all to authenticated
  using (is_approver_or_admin() or exists (select 1 from person_professions p where p.id = profession_id and p.person_gahoi_id = current_gahoi_id()))
  with check (is_approver_or_admin() or exists (select 1 from person_professions p where p.id = profession_id and p.person_gahoi_id = current_gahoi_id()));

-- ───────── Directory RPCs (sirf safe columns; mobile/email/address kabhi nahi) ─────────
create or replace function search_professionals(
  p_category text default null, p_q text default null, p_city text default null,
  p_verified_only boolean default false, p_limit int default 20, p_offset int default 0)
returns table (gahoi_id text, name text, photo text, city text, native text, akna text,
               is_registered boolean, tags jsonb, total_count bigint)
language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(trim(coalesce(p_q,'')), '');
        v_city text := nullif(trim(coalesce(p_city,'')), '');
begin
  if not (coalesce(is_approved_member(), false) or coalesce(is_approver_or_admin(), false)) then
    raise exception 'Not allowed';
  end if;
  return query
  with vis as (            -- doosron ko dikhne layak tags
    select pp.*, c.label_hi, c.label_en, c.icon
    from person_professions pp join profession_categories c on c.slug = pp.category_slug
    where pp.deleted_at is null and c.active and pp.visibility <> 'hidden'
      and (not c.sensitive or pp.member_confirmed)
  ),
  matched as (
    select distinct p.gahoi_id
    from persons p join vis v on v.person_gahoi_id = p.gahoi_id
    where p.status = 'Approved'
      and (p_category is null or v.category_slug = p_category)
      and (not p_verified_only or v.verification_status = 'verified')
      and (v_city is null or lower(coalesce(p.city,'') || ' ' || coalesce(v.city,'')) like '%' || lower(v_city) || '%')
      and (v_q is null or lower(concat_ws(' ', p.name, p.native, p.akna, v.title, v.organization, v.specialization, v.qualification, v.label_hi, v.label_en)) like '%' || lower(v_q) || '%')
  ),
  total as (select count(*) as n from matched)
  select p.gahoi_id, p.name,
         case when p.auth_uid is not null then p.photo else null end,
         p.city, p.native, p.akna, (p.auth_uid is not null),
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', v.id, 'category', v.category_slug, 'label_hi', v.label_hi, 'icon', v.icon,
                   'title', v.title, 'organization', v.organization, 'specialization', v.specialization,
                   'qualification', v.qualification, 'city', v.city, 'details', v.details,
                   'verified', v.verification_status = 'verified') order by v.category_slug, v.title), '[]'::jsonb)
            from vis v where v.person_gahoi_id = p.gahoi_id),
         (select n from total)
  from persons p join matched m on m.gahoi_id = p.gahoi_id
  order by p.name
  limit least(greatest(p_limit,1),100) offset greatest(p_offset,0);
end;
$$;

create or replace function profession_category_counts()
returns table (slug text, label_hi text, label_en text, icon text, group_key text, sort_order int, people bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (coalesce(is_approved_member(), false) or coalesce(is_approver_or_admin(), false)) then raise exception 'Not allowed'; end if;
  return query
  select c.slug, c.label_hi, c.label_en, c.icon, c.group_key, c.sort_order,
         (select count(distinct pp.person_gahoi_id) from person_professions pp join persons p on p.gahoi_id = pp.person_gahoi_id
           where pp.category_slug = c.slug and pp.deleted_at is null and pp.visibility <> 'hidden'
             and (not c.sensitive or pp.member_confirmed) and p.status = 'Approved')
  from profession_categories c where c.active order by c.sort_order, c.label_hi;
end;
$$;

grant execute on function search_professionals(text,text,text,boolean,int,int) to authenticated;
grant execute on function profession_category_counts() to authenticated;
-- FILE: C:\Users\gaurav.reja\Downloads\gahoi-portal-v2\gahoi-portal-v2\supabase\seed_akna_list.sql
-- ============================================================================
-- Gahoi Portal — Seed: Akna List (222 verified entries)
-- मौजूदा Code.gs के INITIAL_AKNAS array से programmatically निकाला गया —
-- हाथ से टाइप नहीं किया, इसलिए transcription-error का खतरा नहीं
-- ============================================================================

insert into akna_list (hindi, english, variants, added_by) values
  ('रूसिया', 'rusia', 'rusia rusiya', 'system'),
  ('अरुसिया', 'arusia', 'arusia arusiya', 'system'),
  ('बेहरे', 'behre', 'behre behr', 'system'),
  ('पहारिया', 'pahariya', 'pahariya pahari', 'system'),
  ('रेजा', 'reja', 'reja', 'system'),
  ('मर', 'mar', 'mar', 'system'),
  ('मोर', 'mor', 'mor', 'system'),
  ('मोदी', 'modi', 'modi', 'system'),
  ('सेठिया', 'sethiya', 'sethiya sethi', 'system'),
  ('दमेले', 'damele', 'damele damel', 'system'),
  ('कठल', 'kathal', 'kathal kathl', 'system'),
  ('मरेले', 'marele', 'marele marel', 'system'),
  ('नाहर', 'nahar', 'nahar', 'system'),
  ('कारेखेमऊ', 'karekhamau', 'karekhamau karekhe', 'system'),
  ('रघारे', 'raghare', 'raghare raghar', 'system'),
  ('टुड़हा', 'tudha', 'tudha turha', 'system'),
  ('साह', 'sah', 'sah', 'system'),
  ('साव', 'sav', 'sav saw', 'system'),
  ('कसाव', 'kasav', 'kasav kasaw', 'system'),
  ('खैरा', 'khaira', 'khaira khera', 'system'),
  ('धूसर', 'dhusar', 'dhusar dhoosar', 'system'),
  ('सहदेले', 'sahdele', 'sahdele sahd', 'system'),
  ('ददरया', 'dadarya', 'dadarya dadry', 'system'),
  ('चुनगेले', 'chungele', 'chungele chungel', 'system'),
  ('सरावगी', 'sarawagi', 'sarawagi sarogi', 'system'),
  ('पटोदिया', 'patodiya', 'patodiya patodi', 'system'),
  ('पटेरहा', 'paterha', 'paterha paterh', 'system'),
  ('खरया', 'kharya', 'kharya', 'system'),
  ('बरया', 'barya', 'barya', 'system'),
  ('कुनयार', 'kunyar', 'kunyar kuniyar', 'system'),
  ('पूरनपुरिया', 'puranpuriya', 'puranpuriya pooranpuri', 'system'),
  ('झांझर', 'jhanjhar', 'jhanjhar jhanjh', 'system'),
  ('बागर', 'bagar', 'bagar', 'system'),
  ('सेठ', 'seth', 'seth', 'system'),
  ('छिरोल्या', 'chiroliya', 'chiroliya chirolay', 'system'),
  ('तरसोलिया', 'tarsoliya', 'tarsoliya tarsoli', 'system'),
  ('जकोन्या', 'jakonya', 'jakonya jakon', 'system'),
  ('कन्थरिया', 'kanthariya', 'kanthariya kanthari', 'system'),
  ('कटारे', 'katare', 'katare katar', 'system'),
  ('जौरिया', 'jauriya', 'jauriya jauri', 'system'),
  ('इटोरिया', 'itoriya', 'itoriya itori', 'system'),
  ('कुरेले', 'kurele', 'kurele kurel', 'system'),
  ('विलैया', 'vilaiya', 'vilaiya vilai', 'system'),
  ('बड़ेरिया', 'bareriya', 'bareriya baderi', 'system'),
  ('निगोती', 'nigoti', 'nigoti', 'system'),
  ('सोनी', 'soni', 'soni', 'system'),
  ('रावत', 'rawat', 'rawat raut', 'system'),
  ('ब्रिजपुरिया', 'brijpuriya', 'brijpuriya brijpuri', 'system'),
  ('गन्धी', 'gandhi', 'gandhi gandi', 'system'),
  ('सिजरिया', 'sijariya', 'sijariya sijari', 'system'),
  ('बमोरिया', 'bamoriya', 'bamoriya bamori', 'system'),
  ('दोहरिया', 'dohariya', 'dohariya dohari', 'system'),
  ('देवरहा', 'dewarha', 'dewarha dewrha', 'system'),
  ('मुनगेले', 'mungele', 'mungele mungel', 'system'),
  ('कुरोठिया', 'kurothiya', 'kurothiya kurothi', 'system'),
  ('भगोरया', 'bhagorya', 'bhagorya bhagory', 'system'),
  ('हडयाल', 'hadyal', 'hadyal', 'system'),
  ('बेद', 'bed', 'bed ved', 'system'),
  ('बरदिया', 'bardiya', 'bardiya bardi', 'system'),
  ('मिहोनिया', 'mihoniya', 'mihoniya mihoni', 'system'),
  ('दिगोरिया', 'digoriya', 'digoriya digori', 'system'),
  ('जार', 'jar', 'jar', 'system'),
  ('पटवारी', 'patwari', 'patwari patwar', 'system'),
  ('गंधी', 'gandhi', 'gandhi gandi', 'system'),
  ('गेडा', 'geda', 'geda', 'system'),
  ('चपरा', 'chapra', 'chapra', 'system'),
  ('नोगरैया', 'nogaraiya', 'nogaraiya nograiya', 'system'),
  ('झुड़ेले', 'jhudele', 'jhudele jhudel', 'system'),
  ('डेंगरे', 'dengre', 'dengre denger', 'system'),
  ('बरेले', 'barele', 'barele barel', 'system'),
  ('नौलहा', 'naulaha', 'naulaha naulh', 'system'),
  ('साब', 'sab', 'sab', 'system'),
  ('पटरैया', 'patraiya', 'patraiya patrai', 'system'),
  ('बरहा', 'barha', 'barha', 'system'),
  ('हथनोरिया', 'hathnoriya', 'hathnoriya hathnori', 'system'),
  ('दमोरहा', 'damorha', 'damorha', 'system'),
  ('लखटकिया', 'lakhatkiya', 'lakhatkiya lakhatki', 'system'),
  ('पहारू', 'paharu', 'paharu', 'system'),
  ('दगरिहा', 'dagariha', 'dagariha', 'system'),
  ('कुरेटिया', 'kuretiya', 'kuretiya kureti', 'system'),
  ('गुगोरिया', 'gugoriya', 'gugoriya gugori', 'system'),
  ('जुगोरिया', 'jugoriya', 'jugoriya jugori', 'system'),
  ('सुलगनिया', 'sulagniya', 'sulagniya sulagni', 'system'),
  ('सावला', 'sawla', 'sawla savla', 'system'),
  ('वगेरिया', 'vageriya', 'vageriya vageri', 'system'),
  ('नीखरा', 'nikhra', 'nikhra neekh', 'system'),
  ('इन्दुरख्या', 'indurkya', 'indurkya indurkhya', 'system'),
  ('कस्तवार', 'kastawar', 'kastawar kastwar', 'system'),
  ('मिसुरहा', 'misurha', 'misurha', 'system'),
  ('विसवारी', 'viswari', 'viswari bistwari', 'system'),
  ('पिपरसानिया', 'piparsaniya', 'piparsaniya piparsa', 'system'),
  ('नाछोला', 'nachola', 'nachola', 'system'),
  ('बड़ोन्या', 'baronya', 'baronya badony', 'system'),
  ('बिनौरया', 'binaurya', 'binaurya binaury', 'system'),
  ('इकसड़े', 'iksade', 'iksade', 'system'),
  ('सुलगहनया', 'sulganaya', 'sulganaya sulgana', 'system'),
  ('कंजौल्या', 'kanjaulya', 'kanjaulya kanjol', 'system'),
  ('निगोतिया', 'nigotiya', 'nigotiya', 'system'),
  ('नगरिया', 'nagariya', 'nagariya nagari', 'system'),
  ('रिखोल्या', 'rikholya', 'rikholya rikhol', 'system'),
  ('लखौरया', 'lakhaurya', 'lakhaurya', 'system'),
  ('शिपौल्या', 'shipaulya', 'shipaulya shipol', 'system'),
  ('लहारिया', 'lahariya', 'lahariya lahari', 'system'),
  ('सिरोजिया', 'sirojiya', 'sirojiya siroji', 'system'),
  ('कुचिया', 'kuchiya', 'kuchiya kuchi', 'system'),
  ('टिकरया', 'tikarya', 'tikarya', 'system'),
  ('बरसैंया', 'barsaiya', 'barsaiya barsain', 'system'),
  ('तपा', 'tapa', 'tapa', 'system'),
  ('मातेले', 'matele', 'matele matel', 'system'),
  ('हुँका', 'hunka', 'hunka huka', 'system'),
  ('धनोरिया', 'dhanoriya', 'dhanoriya dhanori', 'system'),
  ('इटोदिया', 'itodiya', 'itodiya itodi', 'system'),
  ('सकेरे', 'sakere', 'sakere saker', 'system'),
  ('खड़सरिया', 'khadarsariya', 'khadarsariya khadarsa', 'system'),
  ('बढ़िया', 'badhiya', 'badhiya badhi', 'system'),
  ('विनौरया', 'vinaurya', 'vinaurya vinaury', 'system'),
  ('सिरसोनिया', 'sirsoniya', 'sirsoniya sirsoni', 'system'),
  ('खांगट', 'khangat', 'khangat', 'system'),
  ('शिकोल्या', 'shikolya', 'shikolya shikol', 'system'),
  ('तुसेले', 'tusele', 'tusele tusel', 'system'),
  ('भोंदिया', 'bhondiya', 'bhondiya bhondi', 'system'),
  ('अमौरिया', 'amauriya', 'amauriya amauri', 'system'),
  ('कुदरया', 'kudarya', 'kudarya', 'system'),
  ('खर्द', 'khard', 'khard', 'system'),
  ('सोहाने', 'sohane', 'sohane sohan', 'system'),
  ('सुहाने', 'suhane', 'suhane suhan', 'system'),
  ('तीतबिलासी', 'titbilasi', 'titbilasi titbila', 'system'),
  ('घुरा', 'ghura', 'ghura', 'system'),
  ('बजरंगगडिया', 'bajranggadiya', 'bajranggadiya bajrang', 'system'),
  ('नैना', 'naina', 'naina', 'system'),
  ('पचनोले', 'pachnole', 'pachnole pachno', 'system'),
  ('चन्दैया', 'chandaiya', 'chandaiya chandai', 'system'),
  ('कन्देले', 'kandele', 'kandele kandel', 'system'),
  ('लोहिया', 'lohiya', 'lohiya lohi', 'system'),
  ('शाव', 'shav', 'shav', 'system'),
  ('झूके', 'jhuke', 'jhuke jhuk', 'system'),
  ('आसू', 'aasu', 'aasu asu', 'system'),
  ('खंताल', 'khantal', 'khantal', 'system'),
  ('बेडर', 'bedar', 'bedar bedr', 'system'),
  ('सुदीपा', 'sudipa', 'sudipa sudeep', 'system'),
  ('आसुदीपा', 'asudipa', 'asudipa asudeep', 'system'),
  ('दीपा', 'deepa', 'deepa dipa', 'system'),
  ('शाह', 'shah', 'shah', 'system'),
  ('पचरौल्या', 'pachraulya', 'pachraulya pachrol', 'system'),
  ('चुपरा', 'chupra', 'chupra', 'system'),
  ('सकोरया', 'sakorya', 'sakorya', 'system'),
  ('छावला', 'chhawla', 'chhawla chhawal', 'system'),
  ('साहु', 'sahu', 'sahu', 'system'),
  ('कठिल', 'khatil', 'khatil kathil', 'system'),
  ('महतेले', 'mahatele', 'mahatele mahtel', 'system'),
  ('रिसौनिया', 'risauniya', 'risauniya risauni', 'system'),
  ('सादेले', 'sadele', 'sadele sadel', 'system'),
  ('जोलिया', 'joliya', 'joliya joli', 'system'),
  ('जालौन्या', 'jalaunya', 'jalaunya jaloun', 'system'),
  ('सिजारिया', 'sijariya', 'sijariya sijari', 'system'),
  ('अमोरिया', 'amoriya', 'amoriya amori', 'system'),
  ('डेवढीया', 'devdhiya', 'devdhiya devdhi', 'system'),
  ('मनगोले', 'mangole', 'mangole mangol', 'system'),
  ('मौनया', 'maunya', 'maunya maun', 'system'),
  ('बर्घिया', 'barghiya', 'barghiya barghi', 'system'),
  ('ढीगौरिया', 'dhigauriya', 'dhigauriya dhigauri', 'system'),
  ('क्षुरेले', 'kshurel', 'kshurel kshurele', 'system'),
  ('बरोल', 'barol', 'barol', 'system'),
  ('हथनोटिया', 'hatnotiya', 'hatnotiya hatnoti', 'system'),
  ('कुरैठिया', 'kuraithiya', 'kuraithiya kuraithi', 'system'),
  ('उगोरिया', 'ugoriya', 'ugoriya ugori', 'system'),
  ('साउला', 'saula', 'saula saul', 'system'),
  ('खरहा', 'kharha', 'kharha', 'system'),
  ('टपकले', 'tapakle', 'tapakle tapkal', 'system'),
  ('सकहेरे', 'sakahere', 'sakahere sakaher', 'system'),
  ('खरसडिया', 'kharsadiya', 'kharsadiya kharsadi', 'system'),
  ('झूड', 'jhud', 'jhud', 'system'),
  ('जुरेले', 'jurele', 'jurele jurel', 'system'),
  ('आसूपी', 'asupi', 'asupi asoop', 'system'),
  ('आसूती', 'asuti', 'asuti asoot', 'system'),
  ('बाडिल', 'badil', 'badil baadil', 'system'),
  ('बैडाल', 'baidal', 'baidal baidaal', 'system'),
  ('टीपा', 'tipa', 'tipa teep', 'system'),
  ('तीपा', 'tipa', 'tipa teep', 'system'),
  ('झूंक', 'jhunk', 'jhunk jhoonk', 'system'),
  ('नेहना', 'nehna', 'nehna nehan', 'system'),
  ('तीतबिरासी', 'titbirasi', 'titbirasi titbira', 'system'),
  ('भोंदू', 'bhondu', 'bhondu bhond', 'system'),
  ('मसौरया', 'masaurya', 'masaurya masaury', 'system'),
  ('मिसुरया', 'misurya', 'misurya misury', 'system'),
  ('मिही के कुंवर', 'mihi', 'mihi ke kunwar', 'system'),
  ('चौदा', 'chauda', 'chauda chaud', 'system'),
  ('चोदहा', 'chodaha', 'chodaha chodah', 'system'),
  ('बिलैया', 'bilaiya', 'bilaiya bilai', 'system'),
  ('चऊदा', 'chauda', 'chauda chaud', 'system'),
  ('सिपौल्या', 'sipaulya', 'sipaulya sipaul', 'system'),
  ('बहरे', 'behre', 'behre behr', 'system'),
  ('नार', 'nar', 'nar', 'system'),
  ('साहदेले', 'sahdele', 'sahdele sahd', 'system'),
  ('चंगेले', 'changele', 'changele changel', 'system'),
  ('पाटोदी', 'patodi', 'patodi', 'system'),
  ('पुरपुरिया', 'puranpuriya', 'puranpuriya', 'system'),
  ('कजार', 'kajar', 'kajar', 'system'),
  ('त्रिसोलिया', 'trisoliya', 'trisoliya trisoli', 'system'),
  ('खैरया', 'khaira', 'khaira khera', 'system'),
  ('सकहरे', 'sakahere', 'sakahere sakaher', 'system'),
  ('निसुंगे', 'nisunge', 'nisunge nisung', 'system'),
  ('निसूरी', 'nisuri', 'nisuri nisoor', 'system'),
  ('डांगरे', 'dangre', 'dangre danger', 'system'),
  ('निलहा', 'nilha', 'nilha', 'system'),
  ('साहू', 'sahu', 'sahu', 'system'),
  ('चउदा', 'chauda', 'chauda chaud', 'system'),
  ('बरेहे', 'barehe', 'barehe bareh', 'system'),
  ('कुचहा', 'kuchaha', 'kuchaha kuchah', 'system'),
  ('टिकरया टपकले', 'tikarya', 'tikarya tapakle', 'system'),
  ('कनकने', 'kankane', 'kankane kanak', 'system'),
  ('अमौल्या', 'amaulya', 'amaulya amaul', 'system'),
  ('झड़', 'jhard', 'jhard jhad', 'system'),
  ('डागरे', 'dagre', 'dagre dager', 'system'),
  ('चन्द्रसेनिया', 'chandraseniya', 'chandraseniya chandrasen', 'system'),
  ('झंक', 'jhank', 'jhank', 'system'),
  ('लोइया', 'loiya', 'loiya loi', 'system'),
  ('बर्षिया', 'barshiya', 'barshiya barshi', 'system'),
  ('अमरोहा', 'amroha', 'amroha', 'system'),
  ('डाडम', 'dadam', 'dadam', 'system'),
  ('सुलगानियाँ', 'sulagniya', 'sulagniya sulagni', 'system'),
  ('सुलगहनाया', 'sulganaiya', 'sulganaiya sulganai', 'system')
on conflict do nothing;
