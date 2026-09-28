-- ============================================================================
-- Gahoi Portal — Migration 0012: Public config + secrets via existing `settings` table
--
-- GR चाहते हैं Cloudinary/Razorpay/Resend जैसी हर चीज़ website (Admin Settings
-- page) से configure हो, code में hardcode ना हो।
--
-- ⚠️ पहले draft में इसके लिए दो नई tables (app_settings/app_secrets) बना दी
-- गई थीं — फिर पता चला कि migration 0003 में इसी मक़सद के लिए **पहले से एक
-- `settings` table (doc_id/data jsonb) डिज़ाइन की जा चुकी थी**
-- (matrimony/daanSeva/paymentAccounts/siteContent/legalPages/notifications/
-- trustInfo जैसे doc_ids का ज़िक्र मूल कमेंट में ही था)। दो parallel config-
-- systems बनाना confusion और bugs का पक्का रास्ता है — इसलिए वो पहला migration
-- हटाकर यह एक ही, मौजूदा table को extend करने वाला migration बनाया गया।
--
-- मौजूदा RLS (0005) सिर्फ़ यह करती थी: `is_admin()` — यानी हर doc सिर्फ़ Admin
-- पढ़/लिख सकता था। पर Cloudinary cloud-name, Razorpay Key ID जैसी publishable
-- values को हर browser-tab को (बिना login के भी, जैसे register.html पर फ़ोटो
-- अपलोड) पढ़ना होता है — इसलिए एक `doc_id = 'publicConfig'` के लिए खुली
-- select-policy जोड़ी गई। और असली secrets (API secret keys) को Admin के अपने
-- browser session से भी सीधे पढ़ने से रोकने के लिए `doc_id = 'secrets'` को
-- मौजूदा admin-select-policy से explicitly बाहर रखा गया — सिर्फ़ service_role
-- (Edge Functions, BYPASSRLS) उसे पढ़/लिख सकता है, बिल्कुल audit_log जैसा
-- pattern।
--
-- कोई भी direct client-side WRITE किसी भी doc पर नहीं — audit-logging ज़रूरी
-- है (admin-update-settings Edge Function से ही, admin-edit-member/
-- admin-set-role जैसा pattern), इसलिए पुरानी settings_write_admin policy भी
-- हटा दी गई।
-- ============================================================================

drop policy if exists settings_read_admin on settings;
drop policy if exists settings_write_admin on settings;

-- publicConfig doc — कोई भी (anon समेत) पढ़ सकता है
create policy settings_read_public on settings
  for select using (doc_id = 'publicConfig');

-- बाक़ी सब doc — सिर्फ़ Admin/Approver, पर 'secrets' doc कभी नहीं (चाहे Admin ही क्यों ना हो)
create policy settings_read_admin on settings
  for select using (doc_id <> 'secrets' and is_approver_or_admin());

-- कोई client-side insert/update/delete policy नहीं — हर write admin-update-settings
-- Edge Function (service_role) से ही होगी

-- ── शुरुआती डिफ़ॉल्ट docs — GR Admin Settings page से इन्हें भरेंगे ──────────
insert into settings (doc_id, data) values
  ('publicConfig', jsonb_build_object(
    'portalName', 'गहोई पोर्टल',
    'portalUrl', 'https://jaigahoi.in',
    'supportEmail', 'gahoi.portal@gmail.com',
    'supportWhatsapp', '',
    'cloudinaryCloudName', '',
    'cloudinaryUploadPreset', '',
    'razorpayKeyId', ''
  )),
  ('emailConfig', jsonb_build_object(
    'resendFromEmail', '',
    'resendFromName', 'Gahoi Portal'
  )),
  ('appConfig', jsonb_build_object(
    'mahasabhaFee', 100,
    'maxApprovers', 10
  )),
  -- असली secrets — value हमेशा खाली शुरू होती है, GR Admin Settings page से भरेंगे।
  -- खाली होने पर Edge Functions Deno.env.get() fallback इस्तेमाल करती हैं
  -- (देखें _shared/settings.ts) ताकि deploy के फ़ौरन बाद भी कुछ ना टूटे।
  ('secrets', jsonb_build_object(
    'cloudinaryApiKey', '',
    'cloudinaryApiSecret', '',
    'resendApiKey', '',
    'razorpayKeySecret', ''
  ))
on conflict (doc_id) do nothing;
