-- ============================================================================
-- Gahoi Portal — Migration 0014: appConfig publicly readable (Mahasabha fee)
--
-- 🔎 mahasabha.html (member-facing application page) बनाते वक़्त मिली असली gap:
-- appConfig doc (mahasabhaFee, maxApprovers) की RLS policy सिर्फ़ is_approver_or_
-- admin() को पढ़ने देती थी (migration 0012)। मतलब कोई साधारण member अपनी
-- Mahasabha application भरने से पहले यह देख ही नहीं सकता था कि fee कितनी है —
-- या तो JS में हार्डकोड करना पड़ता (जो admin के settings बदलने पर चुपचाप ग़लत
-- हो जाता) या fee पूछे बिना ही payment शुरू करनी पड़ती।
--
-- Fix: 'secrets' के अलावा हर doc अब सबको (anon समेत) पढ़ने देते हैं — publicConfig
-- पहले से public थी, अब appConfig/emailConfig भी। इनमें कोई भी असली गुप्त value
-- नहीं है (API keys/secrets हमेशा से अलग 'secrets' doc में हैं, service_role-only,
-- यह migration उसे बिल्कुल नहीं छूती)। maxApprovers/emailConfig का सार्वजनिक होना
-- हानिरहित है — कोई sensitive data नहीं, सिर्फ़ operational config।
-- ============================================================================

drop policy if exists settings_read_public on settings;
drop policy if exists settings_read_admin on settings;

-- 'secrets' doc हमेशा service_role-only रहेगा (कोई client policy नहीं इसे कवर
-- करेगी — ना यह, ना कोई और) — बाक़ी हर doc अब सबको पढ़ने देते हैं।
create policy settings_read_public on settings
  for select using (doc_id <> 'secrets');

-- कोई client-side insert/update/delete policy अब भी नहीं — हर write अब भी सिर्फ़
-- admin-update-settings Edge Function (service_role) से ही होगी, migration 0012 जैसा।
