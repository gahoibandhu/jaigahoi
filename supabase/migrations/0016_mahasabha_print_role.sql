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

create policy pm_select_mahasabha_print on panchayat_memberships
  for select using (coalesce(current_person_role() = 'mahasabhaPrint', false));

create policy pm_update_mahasabha_print on panchayat_memberships
  for update using (coalesce(current_person_role() = 'mahasabhaPrint', false));
