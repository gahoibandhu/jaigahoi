# गहोई पोर्टल — jaigahoi.in (v2: Supabase + Firebase Hosting)

Static MPA (`public/`) + Supabase (Postgres + Auth + Edge Functions). Google Apps Script sirf low-frequency cron ke liye (`gas/`).
Deploy ka order: **`docs/DEPLOY.md`** · Google Sheet se data lana: **`docs/MIGRATION-RUNBOOK.md`**.

## Folder
```
public/                 saare pages + common.css/js, auth.js, akna-picker.js, msf-print.js, config.js
supabase/migrations/    0001 … 0021 (schema, RLS, triggers, RPC)
supabase/functions/     15 Edge Functions (har ek self-contained)
supabase/seed_akna_list.sql   222 akna
supabase/auth-email-templates.md
scripts/                data migration (members, matrimony, interests, mahasabha, content, professions)
gas/                    Apps Script: Panchang/Festivals cron, Sheet exporter (deploy nahi hota)
docs/
```

## Kya-kya hai
- **Login / Signup**: Google · Email Code (OTP) · Email+Password · Mobile OTP (Admin toggle; Supabase me Phone provider chalu hone par hi dikhta hai) · Forgot password · Password change · Email/User ID bhool gaye (`find-user-id`) · Admin ke liye `admin-auth.html`.
- **Profile**: naam, mobile, email (confirm-link), city, native, akna (type-ahead, Hindi/English), keywords, address, social, privacy; tier auto; `change-password`, `display-settings` (6 themes + Classic/Royal).
- **Directory & samaj**: Member Directory, Known Members, Referrals, **Professional / public-life tags** (`professionals`, `my-professions`, `admin-professions`), Akna review (`admin-aknas`).
- **Matrimony**: list + interest (Realtime), 59-field form, biodata print (`matrimony-biodata`).
- **Mahasabha**: form (signature, photo, autofill), payment, admin approval, A4 print, CSV, reset, print-rights.
- **Content**: Business, Jobs, Offers, Events, Gallery (bulk upload), Magazine (PDF), Dharmshala (CSV import), Space, Messages, Daan Seva.
- **Home**: Panchang + Festival widgets.
- **Admin**: members, pending, broadcast, ledger, audit log, privacy/DPDP, feature flags, settings, auth settings.
- Uploads: Cloudinary (auto-compress) har module me.

## Abhi baaki (sach-sach)
Matrimony tiers/Razorpay/multi-photo/Kundali/My-Interests tab · Home ke birthday/events/gallery/suggestions widgets · Akna aur Cities pages · Admin restore/hard-delete/recent-logins/pending-signups · Email crons (birthday, unread digest, matrimony expiry) · Share previews (`/m/:slug`) · PWA · Family/Census · Gahoi Digital Card (`royal-card.js` chahiye) · Admin 2FA · CAPTCHA · Messages/Space/Ledger ke migrate scripts.

⚠️ Is poore code ko abhi asli Supabase / browser par chalaya nahi gaya hai — pehla deploy staging project par karein.
