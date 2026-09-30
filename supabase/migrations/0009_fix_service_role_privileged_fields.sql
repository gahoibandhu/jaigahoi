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
