-- ============================================================================
-- Gahoi Portal — Migration 0015: featureFlags settings doc
--
-- GR की standing requirement (2026-09-25): Admin को हर feature/page/payment
-- option ऑन-ऑफ करने का पूरा अधिकार होना चाहिए, और बंद होने पर member को एक
-- साफ़ message/popup दिखे — कोई silent 404/broken-page अनुभव ना हो।
--
-- Design: मौजूदा settings table (doc_id/data jsonb) pattern ही दोहराया —
-- नया table नहीं बनाया, migration 0012 वाला convention जारी रखा। 'secrets'
-- के अलावा हर doc migration 0014 से पहले ही publicly readable है, तो
-- featureFlags अपने-आप हर सदस्य (और anon) को दिखेगी बिना किसी नई RLS policy के।
-- ============================================================================

insert into settings (doc_id, data) values
  ('featureFlags', jsonb_build_object(
    -- सबसे पहले से मौजूद pages (retrofit, 2026-09-26 — GR की "admin को हर
    -- feature/page पर पूरा अधिकार" वाली requirement पुरानी pages पर भी लागू)
    'businessEnabled', true,
    'directoryEnabled', true,
    'jobsEnabled', true,
    'matrimonyEnabled', true,
    'messagesEnabled', true,
    'spaceEnabled', true,
    -- इस session में built नई pages (default: true, यानी सब चालू)
    'eventsEnabled', true,
    'galleryEnabled', true,
    'offersEnabled', true,
    'magazinesEnabled', true,
    'dharmshalaEnabled', true,
    'mahasabhaEnabled', true,
    'knownMembersEnabled', true,
    'referralsEnabled', true,
    'daanSevaEnabled', true,
    -- payment options अलग से — feature ही चालू रहे पर सिर्फ़ online payment
    -- बंद करनी हो (जैसे "Razorpay keys issue, paused" — gahoi-portal.md में
    -- पहले से नोट किया मामला) तो feature दिखेगा, बस "Pay Now" button छुप जाएगा
    'mahasabhaOnlinePaymentEnabled', true,
    'donationOnlinePaymentEnabled', true,
    -- सामान्य maintenance-mode जैसा उपयोग — पूरे portal के लिए (अभी सिर्फ़ flag,
    -- असल में लागू करना frontend/common.js का काम है, अलग से)
    'portalMaintenanceMode', false,
    'portalMaintenanceMessage', ''
  ))
on conflict (doc_id) do nothing;
