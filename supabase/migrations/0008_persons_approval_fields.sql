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
