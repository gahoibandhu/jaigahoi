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
create policy offers_read_all on offers for select
  using (deleted_at is null and (valid_till is null or valid_till >= current_date));

create policy offers_write_own_or_admin on offers for all
  using (posted_by = current_gahoi_id() or is_approver_or_admin())
  with check (posted_by = current_gahoi_id() or is_approver_or_admin());
