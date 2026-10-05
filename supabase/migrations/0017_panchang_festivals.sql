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
