# Google Sheet -> Supabase data migration — Runbook

## Aap ke paas pehle se (repo ke scripts/ mein)
migrate-members.js, migrate-matrimony.js, migrate-matrimony-interests.js, migrate-mahasabha.js, migrate-content.js,
create-auth-users.js — ye CSV padhkar SQL banate hain. Inhe is patch mein badla NAHI gaya.

## Is patch mein naya
| File | Kaam |
|---|---|
| gas/Export-All-Sheets.gs | Live Sheet ke 30 tabs ko Drive folder mein CSV + `_manifest.csv` (row counts) |
| scripts/migrate-professions.js | Members ke Profession/Designation se Professional tags suggest (SQL). Politician kabhi auto nahi |
| supabase/migrations/0019_professional_tags.sql | Tags ke tables + RLS + RPC |
| tests/pg_harness.py, tests/test_prof.py | Asli Postgres par migrations + 25 behaviour checks (pip install pgserver psycopg2-binary) |

## Order
1. Sheet wale Apps Script project mein `Export-All-Sheets.gs` (alag file) daalo -> `exportAllSheetsToDrive()` chalao -> Drive folder download karo -> CSVs ko scripts/ ke paas rakho. `_manifest.csv` sambhal kar rakho.
2. Supabase mein migrations 0001..0019 (SQL Editor / `supabase db push`).
3. `node migrate-members.js Members.csv > 01_members.sql` (run karo). Phir:
   `select setval('gahoi_id_seq', (select max(substring(gahoi_id from 3)::int) from persons));`
4. migrate-matrimony / -interests / -mahasabha / -content (README ke hisaab se), phir create-auth-users.js.
5. `node migrate-professions.js Members.csv --report` (pehle sirf report), theek lage to `> 0020_professions.sql` run karo.
   stderr ki "political jaisa shabd" list ko Admin -> admin-professions.html se hath se tag karo (member ki pushti ke baad dikhega).
6. Verification: har table ka count `_manifest.csv` se milao; 20-30 random rows; ledger SUM; RLS non-admin se test.

## Abhi BAKI (in sheets ke liye migrate script nahi hai)
Messages, GahoiSpace, SpaceComments, Ledger, Referrals, KnownMembers (Members col 42), PendingSignups, AuditLog, LoginHistory,
HiddenSuggestions, TierPayments, MahasabhaPayments, PendingAknas, Notifications. Exporter inko CSV mein nikal deta hai;
scripts agle batch mein (table schemas v2 mein pehle se maujood hain: conversations/messages, space_posts/comments, ledger_entries, known_members, pending_signups, audit_log).
Panchang/Festivals migrate nahi karne — cron khud bhar deta hai.

## Suraksha
Export CSV mein Members.Password plaintext hota hai (migrate-members.js use kabhi copy nahi karta). Migration ke baad Drive folder DELETE karo.
