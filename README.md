# गहोई पोर्टल v2 — Supabase Migration

यह folder भाग 1 (Foundation) का **Stage 1 — Local Development** काम है। पूरा context
`Gahoi-Portal-FINAL-Consolidated-Document.md` में है — कोई भी बदलाव करने से पहले वो
document ज़रूर देखें, ये उसी का code-implementation है।

## अभी तक क्या बना (और टेस्ट हो चुका)

`supabase/migrations/` में 6 SQL files हैं — **एक असली local Postgres पर चलाकर
verify किया गया है** (सिर्फ़ लिखकर नहीं छोड़ा गया):

| File | क्या है |
|---|---|
| `0001_core_identity.sql` | persons, families, known_members, claim_requests, local_panchayats, mandals, panchayat_memberships + GahoiId/FamilyId sequence-based generation |
| `0002_matrimony_and_content.sql` | matrimony_profiles, matrimony_interests, business_listings, jobs, events, gallery, dharmshala, magazines, conversations/messages, Gahoi Space |
| `0003_financial_and_operations.sql` | Donations, Ledger, Audit Log, Feedback, Pending Signups, Ads/Sponsorships, Settings |
| `0004_dpdp_compliance.sql` | data_requests, security_incidents, privacy_documents (भाग 9) |
| `0005_rls_policies.sql` | हर table पर Row Level Security — **34/34 tables covered**, कोई table बिना RLS के नहीं |
| `0006_akna_list_and_constraints.sql` | akna_list (पहले छूट गया था), mobile-uniqueness DB-constraint |
| `0007_profile_security_and_tier.sql` | **⚠️ Security fix** — पहले कोई भी अपना status/role खुद बदल सकता था (self-approve/self-Admin!) क्योंकि RLS सिर्फ़ row-level check करती थी, column-level नहीं। अब trigger गैर-Admin को status/role/gahoi_id/auth_uid बदलने से रोकता है। साथ ही profile_tier/completion_percent अब हर update पर खुद calculate होते हैं (मौजूदा calculateProfileCompletion() का SQL-equivalent) |
| `0008_persons_approval_fields.sql` | approved_by/approved_at persons पर जोड़े, 0007 का trigger इन्हें भी protect करने के लिए re-defined |
| `0009_fix_service_role_privileged_fields.sql` | **⚠️ दूसरा genuine bug, इसी बार असल Postgres पर तीन scenarios टेस्ट करके पकड़ा गया** — 0007/0008 का trigger सिर्फ़ `is_admin()` (जो `auth.uid()` पर depend करता है) चेक करता था। Edge Functions (`approve-member` वगैरह) service_role key से चलते हैं जहाँ `auth.uid()` हमेशा NULL होता है — नतीजा: **Admin का "Approve" बटन दबाना Postgres में चुपचाप कोई असर नहीं करता था** (status वापस 'Pending' पर पलट जाता, कोई error भी नहीं आता)। Fix: trigger अब `auth.role() = 'service_role'` को भी भरोसा करता है |
| `0010_extend_panchayat_memberships.sql` | migrate-mahasabha.js लिखते वक़्त मिला gap — पुरानी MahasabhaMembers sheet के कई fields (Vyavsay/Shiksha/DOB/payment-steps/Remarks) नए `panchayat_memberships` में कहीं थे ही नहीं। `form_data` jsonb (persons.profile जैसा pattern) + payment_received/forwarded/form_submitted के actual workflow-columns जोड़े |
| `0011_add_offers_table.sql` | migrate-content.js लिखते वक़्त मिला gap — legacy Code.gs में "Current Offers" का पूरा module है, पर उसका Postgres table कभी बना ही नहीं गया था (README में पहले ग़लती से "पहले से है" लिखा गया था)। business_listings जैसा ही owner/admin-write + auto-expiry (ValidTill) pattern |
| `0012_public_config_and_secrets.sql` | GR का फ़ैसला — Cloudinary/Razorpay/Resend जैसी हर चीज़ website (Admin Settings page) से configure हो, code में hardcode ना हो। **पहले draft में दो नई tables बना दी गई थीं, फिर पता चला 0003 में इसी मक़सद के लिए एक `settings` table (doc_id/data jsonb) पहले से मौजूद थी** — parallel config-systems से बचने के लिए वो draft हटाकर इसी मौजूदा table की RLS extend की गई: `publicConfig` doc कोई भी पढ़ सकता है (Cloudinary cloud-name जैसी publishable values के लिए ज़रूरी), बाक़ी docs सिर्फ़ Admin/Approver, और `secrets` doc किसी भी client session (Admin समेत) को कभी नहीं दिखता — सिर्फ़ service_role |
| `0013_messaging_space_daan_helpers.sql` | Messaging/Gahoi Space/Daan Seva पेज बनाते वक़्त ज़रूरत पड़ी — `get_or_create_conversation()` (race-safe, participant-ordering वाला), `toggle_space_like()` (RLS सिर्फ़ post-author को update करने देती, इसलिए atomic RPC ज़रूरी), `increment_campaign_raised()`, और comment_count auto-sync trigger। असल Postgres पर टेस्ट करके एक bug मिला और ठीक हुआ: like-count खाली होने पर `array_length` NULL देता है (Postgres का known behaviour), `coalesce(...,0)` से ठीक किया |

## 🔧 Configurable Settings System (GR का फ़ैसला — सब कुछ website से configure हो)

तीन हिस्से:
1. **`public/config.js`** — इकलौती genuinely-static file (Supabase URL + anon key, "chicken-and-egg" समस्या की वजह से — browser को Supabase से बात करने के लिए यही दो values चाहिए, इन्हें ख़ुद Supabase से पढ़ना मुमकिन नहीं)। हर 15 pages में `common.js` से पहले load होती है।
2. **`settings` table** (doc_id/data jsonb, मौजूदा migration 0003) — Admin Settings page (`admin-settings.html`) से यहीं सब कुछ set होता है: portal branding, Cloudinary cloud-name/upload-preset, Razorpay Key ID (publishable values — `publicConfig` doc, कोई भी पढ़ सकता है), Resend from-email/name, Mahasabha fee, max-approvers (`emailConfig`/`appConfig` docs — Admin/Approver-only), और असली secrets — Cloudinary API Key/Secret, Razorpay Key Secret, Resend API Key (`secrets` doc — **किसी भी client session को, Admin समेत, कभी नहीं दिखता** — सिर्फ़ service_role)।
3. **`admin-settings.html`** + **`admin-get-settings`/`admin-update-settings` Edge Functions** — GUI form; secrets के लिए सिर्फ़ "Configured/Set नहीं है" badge दिखता है, कभी असली value नहीं; save करने पर audit_log में सिर्फ़ key-names जाते हैं, values कभी नहीं।

**Verification किया गया** (real Postgres 16 पर, realistic Supabase-जैसे roles के साथ — पाँच scenario): anon सिर्फ़ publicConfig देखे, non-admin member भी सिर्फ़ publicConfig, Admin publicConfig+emailConfig+appConfig देखे पर secrets कभी नहीं, Admin का अपना direct client-side write attempt blocked (सिर्फ़ Edge Function से audit-logged write चलता है), service_role secrets doc सही से पढ़/लिख सके — पाँचों सही निकले।

**⚠️ अभी नहीं हुआ**: कोई Edge Function अभी `_shared/settings.ts` इस्तेमाल नहीं करती (razorpay-create-order अभी भी सीधे `Deno.env.get()` से पढ़ता है) — अगला कदम है सबको इस नए pattern पर migrate करना, ताकि GR का "GUI से configure करते ही असर हो" वाला मक़सद पूरी तरह पूरा हो।

**Verification किया गया** (real Postgres 16 पर, अब दो अलग sessions में — दोनों बार सच में चलाकर, सिर्फ़ code-review से नहीं):
- सभी 10 migrations एक साथ, fresh database पर — कोई error नहीं (कई बार अलग-अलग fresh DB पर दोहराया)
- GahoiId generation, mobile-uniqueness, akna insert — पहले जैसा सब पास
- **दोनों security-trigger fixes असल में टेस्ट किए** (सिर्फ़ लिखकर नहीं छोड़े) — तीन scenario हर बार: (A) असली Admin session से direct client-edit, (B) service_role key से Edge-Function-pattern update, (C) non-admin का self-approve attempt। 0009 से पहले B fail होता था (चुपचाप revert), fix के बाद तीनों सही
- profile_tier auto-calculation टेस्ट किया — नए fields भरने पर % सही से बढ़ा

`supabase/functions/` में अब ये Edge Functions हैं:

| File | क्या है |
|---|---|
| `register/index.ts` | मौजूदा Code.gs के `doRegister()`+`doRegisterQuick()` का equivalent — JWT-verify, duplicate-check, akna-validate, auto-approval-logic, welcome-email, admin-notify, audit-log |
| `approve-member/index.ts` | मौजूदा `doApproveUser()` का equivalent — Admin/Approver की approve/reject action, role-change (Admin-only), max-approver-limit, email+audit |
| `add-akna/index.ts` | मौजूदा `doAddAkna()` का equivalent — akna_list एक ज़िंदा admin-editable table है, hardcoded नहीं (222 entries सिर्फ़ initial seed थीं) |
| `razorpay-create-order/index.ts` | **Generic** — मौजूदा Code.gs में `doMatCreateOrder()`/`doMahasabhaCreateOrder()` जैसे कई near-duplicate functions थे, अब एक ही function `purpose` parameter से matrimonyTier/mahasabhaMembership/donation/adBooking/panchayatMembership सब संभालता है |
| `razorpay-verify-payment/index.ts` | ऊपर वाले का जोड़ीदार — HMAC-SHA256 signature verify (Web Crypto API से, कोई npm dependency नहीं) फिर purpose के हिसाब से सही table update |
| `directory-search/index.ts` | मौजूदा `doSearch()`/`doMemberList()` का equivalent — Edge Function में इसलिए (सीधे supabase-js से नहीं) क्योंकि privacy_settings/showMobile के हिसाब से column-level masking चाहिए (RLS सिर्फ़ row-level करती है) || `matrimony-list/index.ts` | मौजूदा `doMatList()`+`_matEffectivePhotos()` का equivalent — tier-based photo-limit (Gold=1/Platinum=2/Diamond=4) और expiry-masking |
| `matrimony-interest/index.ts` | भाग 3 Phase F.1 का "Bidirectional Interest System" — Shortlist(private) vs Interest(notify), **mutual-match detection** (दोनों तरफ़ interest हो तो status='mutual', दोनों को contact-email) |
| `admin-edit-member/index.ts` | मौजूदा `doAdminEditMember()` का equivalent — Admin/Approver किसी भी member की profile-fields edit करते हैं (email कभी नहीं), Approver status नहीं बदल सकता, audit-logged। **0009 के fix पर निर्भर** — उससे पहले status-edit चुपचाप fail होता |
| `admin-set-role/index.ts` | मौजूदा `doSetRole()` का equivalent — Admin-only, MAX_APPROVERS=10 limit, **नया safeguard**: आख़िरी बचे हुए Admin को demote नहीं किया जा सकता (मौजूदा ADMIN_MOBILE hardcode-protection का ज़्यादा सामान्य version) |
| `admin-get-settings/index.ts` | GR के "सब कुछ website से configure हो" वाले फ़ैसले का हिस्सा — `settings` table के publicConfig/emailConfig/appConfig docs पूरे लौटाता है, secrets doc का सिर्फ़ "configured है या नहीं" (कभी value नहीं) |
| `admin-update-settings/index.ts` | ऊपर वाले का जोड़ीदार — Admin-only, हर doc में सिर्फ़ भेजी गई keys merge होती हैं (पूरा doc overwrite नहीं), secrets के values audit_log में कभी नहीं जाते |
| `_shared/cors.ts`, `_shared/email.ts`, `_shared/settings.ts` | साझा helpers — settings.ts हर Edge Function को Cloudinary/Razorpay/Resend जैसी config `Deno.env.get()` की जगह यहीं से (fallback सहित) पढ़ने देता है |

`public/` में पहला MPA flow है (भाग 2 pattern — असली अलग pages, कोई JS-router नहीं):

| File | क्या है |
|---|---|
| `common.css` | साझा design tokens — **मौजूदा brand रंगों से consistent** (navy #1a3a5c, gold #e8a020, maroon #7a1f3d — Code.gs के email-templates से लिए, नया पैलेट नहीं बनाया) |
| `common.js` | Supabase client init + login-guard + Edge-Function-caller helper |
| `register.html` | Step 1 — सिर्फ़ Auth account (email/password या Google) |
| `auth-callback.html` | Email-confirmation link या Google OAuth के बाद landing — session detect करके सही जगह भेजता है |
| `complete-profile.html` | Step 2 — असली profile-fields, akna-autocomplete (akna_list से live), `register` Edge Function बुलाता है |
| `login.html` | Email/Password + Google Login, status के हिसाब से redirect |
| `pending-approval.html` | Approval का इंतज़ार करने वालों के लिए waiting-page |
| `home.html` | Login के बाद landing/dashboard — profile-summary + बाक़ी sections के tiles (अभी वो pages खुद नहीं बने, सिर्फ़ links हैं) |
| `forgot-password.html` | Supabase Auth के built-in `resetPasswordForEmail`/recovery-session pattern से — email-link भेजना + नया password सेट करना, दोनों एक ही page पर (Supabase redirect वापस यहीं भेजता है) |
| `admin-pending.html` | Admin/Approver के लिए Pending सदस्यों की list — `approve-member` Edge Function यहीं से बुलाया जाता है — **registration → pending → approve → home का पूरा cycle अब end-to-end बना हुआ है** |
| `directory.html` | Member Directory — search+filters (`directory-search` Function से) |
| `profile.html` | मेरी Profile — view/edit — **सीधे `supabase-js` से update** (Edge Function नहीं चाहिए, RLS + migration 0007 का security-trigger खुद protect करते हैं), tier/completion% live दिखता है |
| `matrimony.html` | Matrimony Browse — filters, Shortlist/Interest buttons, **Supabase Realtime subscription** (`postgres_changes` on `matrimony_interests`) से mutual-match बिना page-refresh दिखता है — पुराने Firestore `onSnapshot`-प्लान का Supabase-equivalent, असल में काम कर रहा है |
| `matrimony-form.html` | अपनी matrimony profile बनाना/edit करना — सीधे `supabase-js` (RLS-protected, कोई Edge Function नहीं चाहिए) |
| `business.html` | Business Directory — Browse/Post tabs, सीधे `supabase-js` (कोई privacy-masking ज़रूरत नहीं, RLS ही काफ़ी) |
| `jobs.html` | Job Board — Browse/Post tabs, 60-दिन auto-expiry filter (मौजूदा Code.gs जैसा), सीधे `supabase-js` |
| `admin-members.html` | **Admin Panel #1 (भाग 10 priority-list का पहला item)** — सारे members की list/search/filter (status/role/free-text), pagination, edit-modal (`admin-edit-member` बुलाता है), per-row role-dropdown (`admin-set-role`), client-side CSV export (सारे matching rows, सिर्फ़ current page नहीं)। List/export सीधे `supabase-js` से (RLS पहले से Admin/Approver को हर status दिखाती है — यहाँ कोई masking नहीं चाहिए, इसलिए directory-search जैसा अलग Function बनाना ज़रूरत से ज़्यादा होता) |
| `admin-settings.html` | Admin-only — Cloudinary/Razorpay/Resend/branding के लिए GUI form (`admin-get-settings`/`admin-update-settings` बुलाता है), secrets के लिए सिर्फ़ Configured/नहीं badge |
| `messages.html` | Conversation-list + thread-view (single-page toggle), `get_or_create_conversation()` RPC, Realtime `postgres_changes` subscription live-update के लिए, `?with=<gahoiId>` deep-link (directory.html से) |
| `space.html` | Gahoi Space feed — post (text+optional image-URL), like (`toggle_space_like()` RPC), comment (auto comment_count trigger), pagination |
| `daan-seva.html` | Public page (login ज़रूरी नहीं) — campaigns list + progress-bar, Razorpay checkout, receipt-email। लॉगिन हो तो नाम/मोबाइल/email अपने-आप भर जाते हैं |

**⚠️ क्यों 2-step registration (register → complete-profile), 1-step नहीं?** Supabase Auth डिफ़ॉल्ट रूप से email-confirmation माँगता है — signup तुरंत एक इस्तेमाल-लायक session नहीं देता, पहले confirmation-link पर click ज़रूरी है। इसलिए account-बनाना (Auth) और profile-भरना (persons row) दो अलग कदम हैं — मौजूदा Code.gs के single-step register से यहाँ जान-बूझकर अलग है, Supabase Auth का natural pattern यही है।

## Verification का स्तर — ईमानदार summary

| हिस्सा | कैसे टेस्ट हुआ |
|---|---|
| SQL migrations (सभी 10 + akna-seed) | ✅ असली local Postgres 16 पर चलाकर — 200+ statements, GahoiId/mobile-constraint/RLS/दोनों security-triggers सब functional-tested, कई अलग-अलग fresh DB पर |
| Edge Functions (7) | ✅ असली Deno 2.9.6 binary डाउनलोड करके `deno lint` — पूरा AST/syntax pass, कोई error नहीं। ❌ Supabase SDK के असली types के against full type-check नहीं हो पाया (sandbox का network `esm.sh` तक नहीं पहुँचता) |
| Frontend (.html + common.js/css) | ✅ असली `tidy` (HTML validator) + `node --check` (हर inline script) + CSS brace-balance — सब clean pass |
| Migration scripts (members/matrimony/mahasabha) | ✅ असली Postgres पर end-to-end — fixture CSV से SQL बनाकर, असल में insert करके, FK/jsonb/quote-edge-cases verify किए (नीचे देखें) |
| **कुछ भी browser में खोलकर नहीं देखा गया** | ❌ — असली Supabase project (Stage 2) के बिना end-to-end चलाकर देखना मुमकिन नहीं था |

## Data Migration Scripts (`scripts/`) — भाग 9.15 Phase 6 का पहला concrete step

पुराने Sheets-data को नए Postgres में लाने के लिए (सिर्फ़ योजना नहीं, असली script):

| File | क्या है |
|---|---|
| `_lib/csv-utils.js` | **साझा** CSV-parser, SQL-escape helpers, और GahoiId-assignment logic — पहले migrate-members.js में अकेले था, अब तीनों script इसे इस्तेमाल करती हैं ताकि collision-fix logic कभी दो जगह अलग-अलग ना हो जाए |
| `migrate-members.js` | पुराने "Members" sheet का CSV export → `persons` table। **असली Postgres पर test किया गया** — embedded comma, embedded quotes, missing GahoiId सब सही निकले। _lib में refactor होने के बाद पुराने output से byte-for-byte identical रहता है (regression-verified) |
| `migrate-matrimony.js` | पुराने "Matrimony" sheet का CSV export → `matrimony_profiles`। **createdBy resolution नाज़ुक हिस्सा है** — legacy sheet में CreatedBy एक email है, नए schema में FK सीधे gahoi_id की ओर है, इसलिए members-CSV से email→gahoiId lookup ज़रूरी (वही members-csv जो migrate-members.js को दी गई थी)। जिस row का creator ना मिले उसे insert नहीं करता, सिर्फ़ चेतावनी देकर skip करता है — टूटी FK के साथ चुपचाप insert करने की बजाय। `--generate-census` flag से orphaned creators के लिए census/pendingClaim persons rows भी बन सकती हैं (नीचे "असल data पर मिली बातें" देखें)। `--id-map-out <path>` से legacyId→uuid mapping भी निकलती है (matrimony_interests migration के लिए चाहिए) |
| `migrate-matrimony-interests.js` | पुराने "MatInterest" sheet → `matrimony_interests`। migrate-matrimony.js के `--id-map-out` output पर निर्भर (legacy profile-ID uuid नहीं है)। **Mutual-match detection ख़ुद करता है** — अगर A ने B में और B ने भी A में दिलचस्पी दिखाई हो, दोनों तरफ़ status='mutual' सेट होता है, बिल्कुल matrimony-interest Edge Function के live-behaviour जैसा |
| `migrate-mahasabha.js` | पुराने "MahasabhaMembers" sheet का CSV export → `panchayat_memberships` (migration 0010 के extended columns पर निर्भर)। ⚠️ **GR ने बताया है कि Mahasabha feature 2-3 code-updates के बाद final हुआ — मौजूदा mapping GR के latest Code.gs/index.html से cross-verify होना अभी बाक़ी है** (नीचे "अभी तक जो नहीं बना" #4 देखें) |
| `migrate-content.js` | छोटी content sheets — BusinessDir, JobBoard, CommunityEvents, Gallery, Dharmshala, Magazine, Offers — एक ही script में (हर एक अपने flag से, जो ना दें वो छूट जाए)। business/jobs/offers का posted_by legacy में email है (matrimony जैसा), इसलिए `--members` flag ज़रूरी उनके लिए |
| `create-auth-users.js` | migrate-members.js के SQL के बाद, हर member के लिए असली Supabase Auth account + invite-email (`inviteUserByEmail`)। बाक़ी सबसे अलग — SQL print नहीं करती, सीधे live Supabase API को calls करती है। `--dry-run`/`--execute --limit N`, resume-safe |
| `_test/mock-supabase-server.js` | create-auth-users.js को असल Supabase project के बिना टेस्ट करने के लिए न्यूनतम local HTTP mock (PostgREST + Auth Admin API की shapes नक़ल करता है) |
| `sample-data/members-sample.csv` | Test-data जो migrate-members.js को validate करने के लिए इस्तेमाल हुआ |

**⚠️ Genuine bugs मिले और fix हुए (असल Postgres पर चलाकर ही पकड़ में आए, सिर्फ़ code-review से नहीं)**:
1. `migrate-members.js` — अगर batch में कुछ rows का GahoiId पहले से था (explicit) और कुछ का नहीं (DB के DEFAULT sequence पर निर्भर), तो explicit insert sequence को आगे नहीं बढ़ाता — auto-generate वाली row उसी GahoiId से टकरा जाती, `on conflict do nothing` चुपचाप skip कर देता (data silently गुम)। Fix: script खुद हर row का GahoiId तय करता है, DB के DEFAULT पर कभी निर्भर नहीं।
2. `migrate-mahasabha.js` लिखते वक़्त — schema-gap (ऊपर 0010 का नोट देखें): बिना उस migration के हर INSERT fail होता।
3. `migrate-matrimony.js` में TierStartDate/LastEditedAt/JobCompany/JobCity कॉलम-names पुरानी sheet में शायद कभी set ही नहीं हुए थे — script पहले नाम से ढूँढती है, ना मिले तो column-position से fallback करती है।

**🔎 असल production data (`Gahoi_Portal.xlsx`, GR ने भेजा) पर चलाकर मिली बातें — ये सब सिर्फ़ synthetic fixture से कभी सामने नहीं आतीं**:
4. **`migrate-members.js`**: Code.gs के अंदर ही दो जगह अलग-अलग नाम निकले — sheet-creation वाले array में "Street", पर असली live sheet में (Phase-3 migration से आया) "StreetAddress"। Script "Street" मान रही थी → 0 rows में address भरता, चुपचाप। Fix किया।
5. **`migrate-members.js`**: xlsx→CSV करते वक़्त mobile/pincode जैसे numeric-looking फ़ील्ड में "9044004444.0" जैसा ग़लत suffix आया (export-tool की float-typing) — अलग से ठीक किया, script का bug नहीं था।
6. **`migrate-members.js`**: legacy-quirks.md में documented "Sheets auto-converts MM-DD text को Date में बदल देता है" वाला bug **असल data में confirm हुआ** (Birthday col में "2026-03-04 00:00:00" जैसी values, जिसका साल पूरी तरह बेमानी है)। नया `sanitizeMMDD()` helper (`_lib/csv-utils.js`) असली MM-DD निकालता है, चाहे साल-सहित date हो या सही MM-DD text।
7. **डेटा-गुणवत्ता (script का bug नहीं, GR के review के लिए)**: एक member (GP00000153) का mobile सिर्फ़ 9-digit है — पुराने validation ने कैसे पास होने दिया पता नहीं, manual fix चाहिए।
8. **`migrate-matrimony.js` — सबसे बड़ी बात**: 384 में से 294 rows (76%!) का creator email Members sheet में कहीं नहीं मिला। जाँच में पता चला — इन सबका ID `migr_...` prefix से है (सामान्य profile ID हमेशा `m<timestamp>` होता है) — यानी किसी अलग bulk-import process से सीधे डाले गए थे, बिना पहले उस व्यक्ति को Member बनाए। असल, ज़िंदा community-data है, इसलिए `--generate-census` flag बनाया — नए schema के पहले से डिज़ाइन किए गए census/pendingClaim mechanism (migration 0001) का इस्तेमाल करके हर orphaned creator के लिए एक न्यूनतम persons row बना देता है। इसी feature को टेस्ट करते वक़्त एक mobile-collision bug भी मिला (दो अलग orphaned rows के creators का मोबाइल एक ही निकला — असल में एक ही व्यक्ति ने दो अलग email से दो बार जमा किया था) — fix किया, अब census-generation email और mobile दोनों से dedupe करता है।
9. **`migrate-mahasabha.js` — schema mismatch**: असली MahasabhaMembers sheet का structure Code.gs के MSM_HEADERS constant से पूरी तरह अलग निकला (Shulk/PaymentMode/TransactionRef जैसे columns हैं ही नहीं; इसके बदले MoolNiwas/Address/PhotoUrl/ForwardedBy/ForwardedAt/Hidden और कई खाली Reserved-columns हैं) — बिल्कुल Street/StreetAddress जैसी situation, यानी live sheet किसी और/बाद के code-version से बनी। Script को दोनों shape defensively support करने के लिए फिर से लिखा।
10. **`migrate-matrimony-interests.js`**: MatInterest sheet में 12 rows ऐसे मिले जिनका ProfileID Matrimony sheet में अब कहीं मौजूद नहीं (profile delete हो चुका, पर interest-record सफ़ाई से नहीं हटा) — चुपचाप skip किए गए। कुछ ProfileID केस-असंगत भी मिले ("M1251" बनाम "m1234...") — case-insensitive fallback जोड़ा गया।

**असल Postgres पर पूरी chain एक साथ verify हुई** (330 real members + 384 matrimony profiles + 278 census/pendingClaim + 102 matrimony interests, जिनमें 7 असली mutual-match निकले + 6 Mahasabha applications — सब एक ही fresh database पर, ज़ीरो errors)।

**चलाने का तरीक़ा**:
```bash
# 1. हर Google Sheet अलग से CSV export करें (Members, Matrimony, MatInterest, MahasabhaMembers)
node migrate-members.js members-export.csv > 0011_migrated_members.sql
node migrate-matrimony.js matrimony-export.csv members-export.csv \
  --generate-census --id-map-out mat-id-map.json > 0012_migrated_matrimony.sql
node migrate-matrimony-interests.js matinterest-export.csv mat-id-map.json \
  members-export.csv > 0013_migrated_matrimony_interests.sql
node migrate-mahasabha.js mahasabha-export.csv members-export.csv > 0014_migrated_mahasabha.sql
# 2. चारों .sql फ़ाइलें review करें, हर stderr warning ज़रूर पढ़ें (skip हुई rows की वजह बताती हैं)
# 3. ठीक इसी क्रम में (ऊपर वाला क्रम — FK dependencies की वजह से) Supabase पर चलाएं
# 4. सुझाई गई sequence-reset command चलाएं (migrate-members.js के stderr में है)
```

**Password Migration (भाग 1.7) — अब बन गया**: पुराने plaintext passwords कहीं कॉपी नहीं होते — auth_uid जान-बूझकर हमेशा NULL रहता है। `create-auth-users.js` हर ऐसे member को `inviteUserByEmail()` से एक असली Supabase Auth account + invite-email देता है (createUser+random-password की जगह — cleaner, एक ही API call में account बनता है और member को अपना पासवर्ड सेट करने का link मिल जाता है)। असल Postgres-migration scripts (`migrate-*.js`, SQL-output) से अलग है — यह सीधे live Supabase API से बात करता है, इसलिए:
- **`--dry-run` पहले, `--execute --limit N` बाद में** — डिफ़ॉल्ट रूप से कुछ नहीं भेजता, ग़लती से पूरे 600+ members को bulk-invite होने से बचाने के लिए
- **Resume-able** — जिनका auth_uid पहले से लिंक हो चुका, वो अपने-आप skip होते हैं, दोबारा चलाना हमेशा सुरक्षित है
- **"Already registered" संभालता है** — Admin API में सीधा `getUserByEmail` नहीं है, इसलिए इस rare case में `listUsers()` को page-by-page scan करके match ढूँढता है, फिर सिर्फ़ persons.auth_uid को उससे जोड़ देता है (दोबारा invite नहीं भेजता)
- ⚠️ **कोई असली Supabase project अभी तक नहीं है (Stage 1)** — इसलिए असल API के ख़िलाफ़ कभी नहीं चलाया गया। इसकी जगह `scripts/_test/mock-supabase-server.js` (एक न्यूनतम local HTTP mock, PostgREST + Auth Admin API की exact shapes नक़ल करता है) के ख़िलाफ़ तीन scenario असल HTTP-calls से टेस्ट किए: साफ़ नया invite, "already registered"→relink fallback, और auth_uid-null filter। असल project बनने पर वहाँ पहले `--dry-run`, फिर `--execute --limit 3` जैसे छोटे batch से शुरू करें — Supabase के email rate-limits (ख़ासकर free-tier) को ध्यान में रखते हुए script हर invite के बीच एक delay भी रखती है (`INVITE_DELAY_MS`, डिफ़ॉल्ट 700ms)।

## अभी तक जो नहीं बना (अगला काम)

1. ~~Admin Panel (member list/edit/export/role-management)~~ ✅ बन गया
2. ~~migrate-matrimony.js / migrate-mahasabha.js / migrate-matrimony-interests.js~~ ✅ बन गईं, असल data पर verify भी हो गईं
3. ~~BusinessDir/Gallery/Dharmshala/Offers migration~~ ✅ **बन गई** (`migrate-content.js`)
4. **⚠️ Mahasabha column-mapping पर GR का सवाल अभी खुला है** — फ़िलहाल आगे बढ़ने को कहा गया है, बाद में gap दिखे तो ठीक करेंगे
5. ~~create-auth-users.js~~ ✅ बन गई
6. ~~Configurable Settings System (Cloudinary/Razorpay/Resend/branding — website से)~~ ✅ बन गया
7. ~~Messaging (`messages.html`)~~ ✅ बन गया — conversation-list + thread view, Realtime live-update, `get_or_create_conversation()` RPC (race-safe, migration 0013)
8. ~~Gahoi Space (`space.html`)~~ ✅ बन गया — post/like/comment, `toggle_space_like()` RPC + comment-count trigger (दोनों migration 0013, RLS सिर्फ़ अपनी row update करने देती थी इसलिए ये ज़रूरी थे)
9. ~~Daan Seva (`daan-seva.html`)~~ ✅ बन गया — इसे बनाते वक़्त `razorpay-create-order`/`razorpay-verify-payment` में **दो genuine bugs मिले और ठीक हुए** (नीचे देखें)
10. **बाक़ी**: `events.html`, `privacy-dashboard.html` (home.html में लिंक हैं, पेज नहीं बने), matrimony-photos/tier-upgrade Edge Function, `local_panchayats` seed, Storage buckets, directory-search का GIN-index वाला free-text search
11. **⚠️ अभी अधूरा**: कोई मौजूदा Edge Function (razorpay वाले दो अब कर चुके हैं) अभी भी सीधे `Deno.env.get()` पढ़ती है — बाक़ियों को `_shared/settings.ts` पर migrate करना है (GR के कहने पर जान-बूझकर सबसे आख़िर में)

### 🐛 Daan Seva बनाते वक़्त मिले दो genuine bugs (razorpay-create-order/verify-payment में)

1. **JWT हमेशा ज़रूरी था, donation के लिए भी** — दोनों functions का पहला ही check `if (!jwt) return ... 401` था, जो donation-purpose के अपने ही comment ("अनजान visitors भी कर सकते हैं") और RLS के `donations_insert with check (true)` — "anonymous donors भी कर सकते हैं" — के बिल्कुल उलट था। मतलब बिना login के donate करना **कभी काम ही नहीं करता, हालाँकि code का इरादा यही था**। Fix: JWT अब सिर्फ़ present हो तो पढ़ते हैं, donation के अलावा बाक़ी हर purpose के लिए अब भी ज़रूरी है।
2. **donations table पर कोई UPDATE policy ही नहीं, और anonymous donor अपनी ही insert की row वापस SELECT भी नहीं कर सकता** (RLS: `donor_gahoi_id = current_gahoi_id()`, दोनों तरफ़ NULL होने पर भी बराबर नहीं गिना जाता — **असल Postgres पर टेस्ट करके यही confirm हुआ**: anon का INSERT सफल हुआ, फ़ौरन बाद वही row SELECT करने पर 0 rows मिले)। इसलिए पुराना डिज़ाइन (client पहले row बनाए, फिर बाद में order_id से update करे) पूरी तरह टूटा हुआ था बिना login के। Fix: `razorpay-create-order` अब खुद ही donation row बनाता है (order_id समेत, एक ही साथ) जब purpose='donation' हो — client को कभी उस row को खुद पढ़ने/बदलने की ज़रूरत ही नहीं पड़ती।

## ⚠️ Realtime के लिए ज़रूरी सेटिंग (Stage 2 में याद रखें)

दो जगह Supabase Realtime चाहिए — डिफ़ॉल्ट रूप से नई tables पर ये off होता है:
- `matrimony_interests` — `matrimony.html` का "live mutual-match" feature
- `messages` — `messages.html` का live chat-update (postgres_changes subscription)

दोनों के लिए: Dashboard → Database → Replication, या SQL से:
```sql
alter publication supabase_realtime add table matrimony_interests;
alter publication supabase_realtime add table messages;
```

## अभी तक क्या पूरा (end-to-end) बन चुका है

**Registration → Approval → Login का पूरा cycle** — कोई dead-link नहीं बचा:
`register.html` (account बनाना) → `auth-callback.html` (email-confirm/Google लौटना) →
`complete-profile.html` (profile-fields, `register` Function) → `pending-approval.html`
(इंतज़ार) → Admin `admin-pending.html` से approve करे (`approve-member` Function) →
अगली बार login पर `home.html`। साथ ही `login.html`+`forgot-password.html` से मौजूदा members वापस आ सकते हैं।

**Messaging** — `messages.html`: conversation-list ↔ thread-view, directory.html से "Message" बटन से सीधे शुरू, Realtime live-update।
**Gahoi Space** — `space.html`: post/like/comment, feed pagination।
**Daan Seva** — `daan-seva.html`: campaigns list + progress-bar, बिना login के भी दान (Razorpay), receipt-email।

## Local चलाने के लिए (जब आप तैयार हों — अभी ज़रूरी नहीं)

```bash
npm install -g supabase          # Supabase CLI
supabase init                    # अगर पहले से init नहीं है
supabase start                   # local Postgres + Auth + Storage, Docker चाहिए होगा
supabase db reset                # migrations/ की सारी files क्रम से चलाएगा
```

ये सिर्फ़ तब चाहिए जब आप खुद अपने computer पर टेस्ट करना चाहें — अभी मैंने Sandbox
में एक अलग तरीक़े से (raw Postgres install करके) टेस्ट किया है, इसके लिए कोई
Supabase account/credential नहीं चाहिए था।

## Stage 2 — GR ने Supabase project बना लिया है ✅

अभी GR के पास असली Project URL + anon key + service_role key है। **अगला ज़रूरी कदम** (delivery-plan में शामिल):
1. GR `supabase/migrations/` की सभी 12 files क्रम से अपने project पर चलाएं (Dashboard → SQL Editor, या CLI से `supabase db push`)
2. `public/config.js` में असली `SUPABASE_URL` + `SUPABASE_ANON_KEY` भरें (सिर्फ़ ये दो, बाक़ी सब Admin Settings page से)
3. सभी 11 Edge Functions deploy करें (`supabase functions deploy <name>`) — इन्हें `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` अपने-आप मिल जाती हैं, अलग से set करने की ज़रूरत नहीं
4. Static pages (`public/`) किसी भी static host पर (Firebase Hosting, Netlify, Vercel) deploy करें, या Supabase Storage से भी serve हो सकती हैं
5. `admin-settings.html` खोलकर Cloudinary/Razorpay/Resend की values भरें
6. `create-auth-users.js` से मौजूदा 330 members को असली login-account दें (`--dry-run` पहले)

⚠️ **Service role key कभी chat में नहीं भेजें** — सिर्फ़ Project URL + anon key safe हैं share करने के लिए (ये publishable हैं, RLS ही असली सुरक्षा है)।
