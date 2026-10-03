# v2-patch — Batch 1 + 2 (copy over repo, same folder structure)

| File | Kya karta hai |
|---|---|
| public/common.css | Royal interface: legacy tokens + --gp-* aliases + Classic mode + legacy components. Saare pages bina HTML badle royal dikhenge |
| public/common.js | Purana + naya Display module (6 themes, Classic/Royal) |
| public/display-settings.html | Theme picker + mode toggle page |
| public/home.html | Panchang + Festival widgets + Display Settings tile |
| supabase/migrations/0017_panchang_festivals.sql | panchang_daily, festivals tables (RLS: sirf read) |
| gas/Cron-Panchang-Festivals.gs | ALAG Apps Script project: daily Panchang + weekly Festivals -> Supabase |

Order: 0017 SQL -> GAS setup (README ke upar comment) -> public/ files upload.
Verified: node --check (JS), CSS brace balance. Browser par visual test NAHI hua.
