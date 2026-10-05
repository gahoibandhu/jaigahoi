# v2-patch — Batch 1 + 2 + 3 + 4 + 5 (Professional tags + data-migration kit) (copy over repo, same folder structure)

| File | Kya karta hai |
|---|---|
| public/common.css | Royal interface: legacy tokens + --gp-* aliases + Classic mode + legacy components. Saare pages bina HTML badle royal dikhenge |
| public/common.js | Purana + naya Display module (6 themes, Classic/Royal) |
| public/display-settings.html | Theme picker + mode toggle page |
| public/home.html | Panchang + Festival widgets + Display Settings tile |
| supabase/migrations/0017_panchang_festivals.sql | panchang_daily, festivals tables (RLS: sirf read) |
| gas/Cron-Panchang-Festivals.gs | ALAG Apps Script project: daily Panchang + weekly Festivals -> Supabase |

### Batch 3 — Mahasabha parity + Matrimony biodata
| File | Kya karta hai |
|---|---|
| public/msf-print.js | Legacy A4 print form (verbatim port) + Payments CSV + fee-in-words |
| public/mahasabha.html | Member form: mool niwas, address, photo upload, signature pad, profile autofill, validation (legacy jaisi) |
| public/admin-mahasabha.html | Search, date filter, counts, select-all + print selected, per-card Print, Mark Printed, Detail (photo/signature), Reset (Admin), Payments CSV, Print-Rights manager (Admin) |
| public/matrimony-biodata.html | 404 wala link ab chalega: print-friendly biodata, tier-wise photos, mobile/address sirf owner ko |
| supabase/migrations/0018_mahasabha_parity.sql | Admin-only DELETE policy (Reset ke liye) |

### Batch 4 — Uploads everywhere + Gallery bulk + Dharmshala CSV
| File | Kya karta hai |
|---|---|
| public/common.js | + gpCompressImage (1600px/JPEG), gpUploadFileToCloudinary (PDF bhi), gpWireUpload, gpParseCsvLine; gpUploadToCloudinary ab compress karke 5MB check karta hai |
| public/business.html, offers.html, events.html, matrimony-form.html, space.html | URL box ki jagah file upload (URL fallback bacha hai; space mein hidden) |
| public/magazines.html | Cover image + PDF upload (15MB) |
| public/gallery.html | Ek saath kai photo upload (admin/approver) |
| public/dharmshala.html | CSV import (Sl optional, quoted fields, 100-100 ke batch) + sample CSV download |

Note: Cloudinary account mein PDF delivery band ho to Settings -> Security -> "Allow delivery of PDF and ZIP files" ON karo.
Note: common.js ab pichhle patch wale common.js ko replace karta hai (display module us mein hai).

### Batch 5 — Samaj ke logon ke Professional / Public-life tags
| File | Kya karta hai |
|---|---|
| supabase/migrations/0019_professional_tags.sql | profession_categories (23 seed, admin-editable), person_professions, person_profession_private (reg no.), triggers, RLS, RPC search_professionals + profession_category_counts |
| public/professionals.html | "समाज के विशिष्ट जन": category chips + counts, search, city, sirf-verified, Census badge, message button |
| public/my-professions.html | Apne tags add/edit/hide/delete, auto/admin-added tags ki pushti, verification request, politician details, private reg no. |
| public/admin-professions.html | Verification queue, kisi ko bhi (Census samet) tag, auto-suggested review, Categories CRUD (Admin) |
| public/home.html | + tiles + admin link |
| scripts/migrate-professions.js | Sheet ke Profession text se tags suggest; political kabhi auto nahi |
| gas/Export-All-Sheets.gs, MIGRATION-RUNBOOK.md | Sheet -> CSV exporter aur migration order |

Rules: Politician (sensitive) tag tabhi dikhta hai jab person khud confirm kare; Census entry par kabhi nahi. Directory mein mobile/email/address nahi.

Order: 0017 SQL, 0018 SQL, 0019 SQL -> GAS setup (README ke upar comment) -> public/ files upload.
Verified: node --check (JS), print builder + biodata render smoke-tested offline. Supabase/browser par live test NAHI hua.
