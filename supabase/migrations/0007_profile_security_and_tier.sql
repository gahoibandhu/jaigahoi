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

create trigger trg_protect_privileged_fields
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
create trigger a_protect_privileged_fields
  before update on persons
  for each row execute function protect_privileged_person_fields();

create trigger b_calculate_profile_tier
  before insert or update on persons
  for each row execute function calculate_profile_tier();
