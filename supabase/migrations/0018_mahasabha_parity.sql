-- ============================================================================
-- Gahoi Portal — Migration 0018: Mahasabha parity (legacy doResetMahasabhaApplication)
-- Legacy mein Admin kisi member ki application "reset" kar sakta tha (row delete +
-- member ka mahasabha status clear) taaki wo dobara apply kar sake. v2 mein
-- panchayat_memberships par DELETE policy hi nahi thi — sirf Admin ko yahin grant.
-- Baaki naye fields (mool, address, photo, signature, printedAt, ...) form_data
-- jsonb mein jaate hain, isliye koi nayi column nahi chahiye.
-- ============================================================================
drop policy if exists pm_delete_admin on panchayat_memberships;
create policy pm_delete_admin on panchayat_memberships
  for delete using (coalesce(is_admin(), false));
