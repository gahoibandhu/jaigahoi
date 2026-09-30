-- ============================================================================
-- Gahoi Portal — Migration 0010: Extend panchayat_memberships for Mahasabha
--
-- 🔎 Migration-script लिखते वक़्त मिली एक असली architecture-gap (सिर्फ़ code-review
-- से, migrate-mahasabha.js शुरू करने से पहले पकड़ी गई):
--
-- पुरानी MahasabhaMembers Google Sheet (32 columns — देखें legacy-quirks.md का
-- "Mahasabha MSM sheet schema") में ये सब भी था जो नए `panchayat_memberships`
-- table में कहीं नहीं है:
--   Panchayat, KshetriyaPanchayat, FatherOrHusband, Vyavsay, Shiksha, DOB,
--   PaymentMode, TransactionRef, TransactionDate, RejectedReason,
--   PaymentReceived/By/At, PaymentForwarded/By/At, FormSubmitted/By/At, Remarks
--
-- मौजूदा gahoi-portal.md memory के अनुसार ये सिर्फ़ archival data नहीं है — Admin
-- का 4-step pipeline (approve → payReceived → payForwarded → formSubmitted) इन्हीं
-- fields पर चलता है, यानी बिना इन्हें जोड़े migrate-mahasabha.js या तो data चुपचाप
-- खो देता या insert ही fail हो जाता।
--
-- Fix: दो हिस्सों में —
--   1. जो fields अभी भी सक्रिय workflow-state हैं (payment/form steps) — पहले
--      class के columns, ताकि आगे Admin Panel उन पर सीधे index/filter कर सके
--      (जैसे persons.status पहले से column है, jsonb के अंदर नहीं)
--   2. बाक़ी सब (Panchayat/Kshetriya text, Vyavsay, Shiksha, DOB, payment-mode/ref,
--      rejected-reason, remarks) — एक `form_data jsonb` column में, बिल्कुल
--      `persons.profile` jsonb वाले pattern जैसा (भाग 9 का established convention)
-- ============================================================================

alter table panchayat_memberships
  add column if not exists form_data jsonb not null default '{}'::jsonb,
  -- { panchayat, kshetra, fatherOrHusband, vyavsay, shiksha, dob, paymentMode,
  --   transactionRef, transactionDate, rejectedReason, remarks, fullFormData }

  add column if not exists payment_received      boolean not null default false,
  add column if not exists payment_received_by   text,
  add column if not exists payment_received_at   timestamptz,

  add column if not exists payment_forwarded     boolean not null default false,
  add column if not exists payment_forwarded_by  text,
  add column if not exists payment_forwarded_at  timestamptz,

  add column if not exists form_submitted        boolean not null default false,
  add column if not exists form_submitted_by     text,
  add column if not exists form_submitted_at     timestamptz,

  -- legacy MahasabhaMembers.ApprovedAt — approved_by तो पहले से column था,
  -- approved_at भूल से छूट गया था पहले draft में, migrate-mahasabha.js लिखते
  -- वक़्त पकड़ा गया
  add column if not exists approved_at           timestamptz;
