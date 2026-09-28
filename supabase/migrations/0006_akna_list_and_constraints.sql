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

create policy akna_list_read_all on akna_list for select using (true);
create policy akna_list_write_admin on akna_list for all
  using (is_approver_or_admin()) with check (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- मौजूदा Code.gs में mobile की duplicate-check होती थी (m.mobile === d.mobile) —
-- अब DB-level unique constraint से भी enforce होगी (सिर्फ़ application-check काफ़ी नहीं)
-- ----------------------------------------------------------------------------
create unique index if not exists idx_persons_mobile_unique
  on persons(mobile) where mobile is not null and mobile <> '';
