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
