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
create policy persons_select_approved on persons
  for select using (
    status = 'Approved' or auth_uid = auth.uid() or is_approver_or_admin()
  );

-- अपनी ही row अपडेट कर सकते हैं (status/role खुद नहीं बदल सकते — वो सिर्फ़ Edge Function से,
-- यहाँ WITH CHECK में उन fields को protect करना अलग trigger से होगा, अभी basic policy)
create policy persons_update_own on persons
  for update using (auth_uid = auth.uid() or is_admin())
  with check (auth_uid = auth.uid() or is_admin());

-- नया व्यक्ति सिर्फ़ खुद के लिए insert कर सकता है (registration flow, Edge Function से गुज़रेगा)
create policy persons_insert_self on persons
  for insert with check (auth_uid = auth.uid() or is_approver_or_admin());

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

create policy families_select_members on families
  for select using (
    is_approver_or_admin() or
    exists (select 1 from persons p where p.family_id = families.family_id and p.auth_uid = auth.uid())
  );

create policy families_write_admin on families
  for all using (is_approver_or_admin()) with check (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- known_members
-- ----------------------------------------------------------------------------
alter table known_members enable row level security;

create policy known_members_own on known_members
  for all using (person_gahoi_id = current_gahoi_id() or is_admin())
  with check (person_gahoi_id = current_gahoi_id());

-- ----------------------------------------------------------------------------
-- claim_requests
-- ----------------------------------------------------------------------------
alter table claim_requests enable row level security;

create policy claim_requests_own_or_admin on claim_requests
  for select using (claimant_auth_uid = auth.uid() or is_approver_or_admin());

create policy claim_requests_insert_own on claim_requests
  for insert with check (claimant_auth_uid = auth.uid());

create policy claim_requests_update_admin on claim_requests
  for update using (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- local_panchayats / mandals / mandal_members — public read, admin write
-- ----------------------------------------------------------------------------
alter table local_panchayats enable row level security;
alter table mandals enable row level security;
alter table mandal_members enable row level security;

create policy lp_read_all on local_panchayats for select using (true);
create policy lp_write_admin on local_panchayats for all using (is_admin()) with check (is_admin());

create policy mandals_read_all on mandals for select using (true);
create policy mandals_write_admin on mandals for all using (is_admin()) with check (is_admin());

create policy mandal_members_read_all on mandal_members for select using (true);
create policy mandal_members_write_admin on mandal_members for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- panchayat_memberships
-- ----------------------------------------------------------------------------
alter table panchayat_memberships enable row level security;

create policy pm_select_own_or_admin on panchayat_memberships
  for select using (member_gahoi_id = current_gahoi_id() or is_approver_or_admin());

create policy pm_insert_own on panchayat_memberships
  for insert with check (member_gahoi_id = current_gahoi_id());

create policy pm_update_admin on panchayat_memberships
  for update using (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- matrimony_profiles — highly restricted (भाग 9.7)
-- ----------------------------------------------------------------------------
alter table matrimony_profiles enable row level security;

-- सिर्फ़ approved members पूरा profile देख सकते हैं (contact-masking अभी भी Edge Function से,
-- mutual-interest से पहले mobile ना दिखे — VIEW में column छोड़ा जा सकता है अगर पूरी तरह hide करना हो)
create policy matrimony_select_approved_members on matrimony_profiles
  for select using (
    (status = 'Approved' and deleted_at is null and is_approved_member())
    or created_by = current_gahoi_id()
    or is_approver_or_admin()
  );

create policy matrimony_insert_own on matrimony_profiles
  for insert with check (created_by = current_gahoi_id());

create policy matrimony_update_own_or_admin on matrimony_profiles
  for update using (created_by = current_gahoi_id() or is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- matrimony_interests — सिर्फ़ भेजने वाला और profile-owner देख सकते हैं
-- ----------------------------------------------------------------------------
alter table matrimony_interests enable row level security;

create policy mat_interests_select on matrimony_interests
  for select using (
    from_gahoi_id = current_gahoi_id()
    or exists (select 1 from matrimony_profiles mp where mp.id = to_profile_id and mp.created_by = current_gahoi_id())
    or is_approver_or_admin()
  );

create policy mat_interests_insert on matrimony_interests
  for insert with check (from_gahoi_id = current_gahoi_id());

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

create policy biz_read_all on business_listings for select using (deleted_at is null);
create policy biz_write_own_or_admin on business_listings for all
  using (posted_by = current_gahoi_id() or is_approver_or_admin())
  with check (posted_by = current_gahoi_id() or is_approver_or_admin());

create policy jobs_read_all on jobs for select using (deleted_at is null);
create policy jobs_write_own_or_admin on jobs for all
  using (posted_by = current_gahoi_id() or is_approver_or_admin())
  with check (posted_by = current_gahoi_id() or is_approver_or_admin());

create policy events_read_all on community_events for select using (deleted_at is null);
create policy events_write_admin on community_events for all using (is_admin()) with check (is_admin());

create policy gallery_read_all on gallery for select using (deleted_at is null);
create policy gallery_write_admin on gallery for all using (is_approver_or_admin()) with check (is_approver_or_admin());

create policy dharmshala_read_all on dharmshala for select using (true);
create policy dharmshala_write_admin on dharmshala for all using (is_admin()) with check (is_admin());

create policy magazines_read_all on magazines for select using (true);
create policy magazines_write_admin on magazines for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- Messaging — सिर्फ़ participants
-- ----------------------------------------------------------------------------
alter table conversations enable row level security;
alter table messages enable row level security;

create policy conversations_participants on conversations
  for select using (participant_a = current_gahoi_id() or participant_b = current_gahoi_id() or is_admin());

create policy conversations_insert on conversations
  for insert with check (participant_a = current_gahoi_id() or participant_b = current_gahoi_id());

create policy messages_participants on messages
  for select using (from_gahoi_id = current_gahoi_id() or to_gahoi_id = current_gahoi_id() or is_admin());

create policy messages_insert_own on messages
  for insert with check (from_gahoi_id = current_gahoi_id());

create policy messages_update_participants on messages
  for update using (from_gahoi_id = current_gahoi_id() or to_gahoi_id = current_gahoi_id());

-- ----------------------------------------------------------------------------
-- Gahoi Space (social feed) — approved members read/write, own-or-admin delete
-- ----------------------------------------------------------------------------
alter table space_posts enable row level security;
alter table space_comments enable row level security;

create policy space_posts_read on space_posts for select using (status = 'Active' or is_admin());
create policy space_posts_insert on space_posts for insert with check (author_gahoi_id = current_gahoi_id());
create policy space_posts_update on space_posts for update
  using (author_gahoi_id = current_gahoi_id() or is_approver_or_admin());

create policy space_comments_read on space_comments for select using (status = 'Active' or is_admin());
create policy space_comments_insert on space_comments for insert with check (author_gahoi_id = current_gahoi_id());
create policy space_comments_update on space_comments for update
  using (author_gahoi_id = current_gahoi_id() or is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- Financial tables — Admin/Finance-flag only (भाग 9.8 access-principle)
-- ----------------------------------------------------------------------------
alter table donation_campaigns enable row level security;
alter table donations enable row level security;
alter table donation_pledges enable row level security;
alter table ledger_entries enable row level security;

create policy campaigns_read_all on donation_campaigns for select using (true);
create policy campaigns_write_admin on donation_campaigns for all using (is_approver_or_admin()) with check (is_approver_or_admin());

create policy donations_own_or_admin on donations
  for select using (donor_gahoi_id = current_gahoi_id() or is_approver_or_admin());
create policy donations_insert on donations for insert with check (true);  -- anonymous donors भी कर सकते हैं

create policy pledges_own_or_admin on donation_pledges
  for select using (pledger_gahoi_id = current_gahoi_id() or is_approver_or_admin());
create policy pledges_insert on donation_pledges for insert with check (pledger_gahoi_id = current_gahoi_id());

-- Ledger पूरी तरह financial-flag/admin only — कोई member अपनी entry भी सीधे नहीं देख सकता
create policy ledger_admin_only on ledger_entries for all using (is_approver_or_admin()) with check (is_approver_or_admin());

-- ----------------------------------------------------------------------------
-- audit_log — कोई भी सीधे नहीं लिख सकता (सिर्फ़ SECURITY DEFINER functions/Edge Functions),
-- सिर्फ़ Admin पढ़ सकता है
-- ----------------------------------------------------------------------------
alter table audit_log enable row level security;

create policy audit_read_admin on audit_log for select using (is_admin());
-- कोई insert/update/delete policy जान-बूझकर नहीं दी — सिर्फ़ service_role (Edge Function से,
-- RLS bypass करके) या एक SECURITY DEFINER function लिख सकता है

-- ----------------------------------------------------------------------------
-- ads / sponsorships
-- ----------------------------------------------------------------------------
alter table ads enable row level security;
alter table sponsorships enable row level security;

create policy ads_read_approved on ads for select using (status = 'Approved' or is_admin());
create policy ads_write_admin on ads for all using (is_admin()) with check (is_admin());

create policy sponsorships_read_approved on sponsorships for select using (status = 'Approved' or is_admin());
create policy sponsorships_write_admin on sponsorships for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- settings — Admin-only (कुछ keys जैसे siteContent शायद public-readable होनी चाहिए,
-- अभी conservative default: Admin-only, ज़रूरत पड़ने पर per-key policy बाद में refine होगी)
-- ----------------------------------------------------------------------------
alter table settings enable row level security;

create policy settings_read_admin on settings for select using (is_admin());
create policy settings_write_admin on settings for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- DPDP tables (भाग 9)
-- ----------------------------------------------------------------------------
alter table data_requests enable row level security;
alter table security_incidents enable row level security;
alter table privacy_documents enable row level security;

create policy data_requests_own_or_admin on data_requests
  for select using (user_gahoi_id = current_gahoi_id() or is_approver_or_admin());
create policy data_requests_insert_own on data_requests
  for insert with check (user_gahoi_id = current_gahoi_id());
create policy data_requests_update_admin on data_requests
  for update using (is_approver_or_admin());

create policy incidents_admin_only on security_incidents for all using (is_admin()) with check (is_admin());

create policy privacy_docs_read_all on privacy_documents for select using (true);
create policy privacy_docs_write_admin on privacy_documents for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- feedback / pending_signups
-- ----------------------------------------------------------------------------
alter table feedback enable row level security;
alter table pending_signups enable row level security;

create policy feedback_own_or_admin on feedback
  for select using (submitted_by = current_gahoi_id() or is_approver_or_admin());
create policy feedback_insert on feedback for insert with check (true);

create policy pending_signups_admin_only on pending_signups for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- claim_requests, known_members वगैरह पर ऊपर पहले से cover हो चुका
-- ============================================================================
