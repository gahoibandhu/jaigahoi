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
