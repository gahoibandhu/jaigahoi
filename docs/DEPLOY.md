# Deploy — kis order mein kya chalana hai

Is repo ka folder ढांचा seedha deploy ho sakta hai:

| Folder | Kahan jaata hai |
|---|---|
| `public/` | Firebase Hosting (`firebase deploy --only hosting`) |
| `supabase/migrations/` | Supabase SQL Editor — `0001` se `0021` tak **number ke order** mein, ek-ek karke |
| `supabase/seed_akna_list.sql` | Migrations ke baad ek baar (222 akna — akna type-ahead isi par chalta hai) |
| `supabase/functions/*.ts` | Supabase Dashboard -> Edge Functions (har file self-contained; code paste). Naya: `find-user-id`. Badla: `register` |
| `supabase/auth-email-templates.md` | Padhne ke liye — templates/SMTP Dashboard mein set hote hain |
| `scripts/` | Laptop par `node` se (data migration ke waqt) |
| `gas/` | **Deploy nahi hota** — Google Apps Script mein paste karne ke liye (neeche) |
| `docs/MIGRATION-RUNBOOK.md` | Google Sheet -> Supabase data migration ka order |

## Order
1. **SQL**: migrations 0001..0021 -> `seed_akna_list.sql`.
2. **Edge Functions**: sab functions deploy; `find-user-id` aur `register` is baar zaroor (naye/badle). "Verify JWT" ON rehne do.
3. **Supabase Authentication** (OTP aur Google ke bina login adhoora rahega):
   - SMTP: Resend (Settings -> SMTP) · Email Templates me `{{ .Token }}` · Min password 8 · Redirect URLs `/auth-callback.html`, `/forgot-password.html` — `supabase/auth-email-templates.md` dekho.
   - **Google**: Providers -> Google **ON** (Google Cloud ka OAuth Client ID/Secret; "Authorized redirect URI" = `https://<project>.supabase.co/auth/v1/callback`) · Site URL `https://jaigahoi.in`.
   - Mobile OTP: abhi band rakho (Phone provider + SMS gateway + India DLT ke baad hi). Site ke `admin-auth.html` mein toggle hai.
4. **Hosting**: `firebase deploy --only hosting`.
5. **Apps Script**
   - `gas/Cron-Panchang-Festivals.gs` -> **naya alag** script.google.com project; Script Properties me `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service key sirf wahin); `setupPanchangFestivalTriggers()` ek baar.
   - `gas/Export-All-Sheets.gs` -> live Sheet ke Apps Script project me **nayi file**; sirf data-migration ke waqt `exportAllSheetsToDrive()`.
6. **Realtime**: `alter publication supabase_realtime add table matrimony_interests;` (live mutual-match ke liye).

## Deploy ke baad turant jaanchein
- `login.html` / `register.html` par Google button dikhe. Dikkat ho to `login.html?debug=1` — neeche config + Supabase providers + error dikhta hai.
- Google "provider is not enabled" bole -> step 3 ka Google ON nahi hua. `file://` se Google test nahi hota; live URL ya `npx serve public`.
- Signup mein akna box me `reja` likho -> `रेजा` suggest ho.
- `profile.html` me naam/mobile/email/akna badal kar Save (email badalne par nayi email par link aati hai).
- Admin: `admin-auth.html` (login toggles), `admin-aknas.html` (anjaan akna), `admin-professions.html`.
