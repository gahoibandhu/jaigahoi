#!/usr/bin/env node
// ============================================================================
// create-auth-users.js
//
// migrate-members.js (और matrimony/mahasabha census-generation) से बनी persons
// rows में auth_uid जान-बूझकर हमेशा NULL रहता है (पुराने plaintext passwords
// कहीं कॉपी नहीं होते — भाग 1.7 का फ़ैसला)। यह script हर ऐसे member के लिए एक
// असली Supabase Auth account बनाती है और उन्हें एक invite-email भेजती है
// जिससे वो अपना खुद का password सेट करके पहली बार login कर सकें।
//
// ⚠️ यह अकेली migrate-*.js नहीं है — यह SQL फ़ाइल में print नहीं करती, बल्कि
// सीधे असल Supabase project से **live API calls** करती है (persons table पढ़ना/
// लिखना + Auth Admin API से invite भेजना)। इसलिए:
//   - असल SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY चाहिए (env vars से)
//   - पहले migrate-members.js का SQL असल project पर already चल चुका होना चाहिए
//   - डिफ़ॉल्ट रूप से --dry-run जैसा बर्ताव नहीं — जान-बूझकर --execute देना पड़ता
//     है, ताकि ग़लती से पूरे members-base को bulk-invite-email ना चला जाए
//
// इस्तेमाल:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node create-auth-users.js --dry-run              # पहले सिर्फ़ गिनती देखें
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node create-auth-users.js --execute --limit 50    # असली भेजना, छोटे batch में
//
// ── क्यों limit/batch ज़रूरी है ────────────────────────────────────────────
// Supabase का auth email-sending (SMTP कॉन्फ़िगर ना हो तो built-in mailer) पर
// सख़्त rate-limit है (free-tier पर प्रति-घंटा भी सीमित) — पूरे 600+ members को
// एक साथ भेजने की कोशिश करने से बीच में ही emails fail होने लगेंगी। इसलिए
// --limit (डिफ़ॉल्ट 50) + हर call के बीच एक छोटा delay, और **resume-able**
// (जो auth_uid पहले से लिंक हो चुके, वो हर बार अपने-आप skip होते हैं — दोबारा
// चलाना हमेशा सुरक्षित है)।
//
// ── ⚠️ इस sandbox में कभी असल Supabase project के against चलाकर नहीं देखा गया ──
// (कोई real project अभी मौजूद नहीं — अभी भी Stage 1)। इसकी जगह supabase-js की
// असल HTTP-call shapes के against एक mock local server से टेस्ट किया गया —
// देखें scripts/_test/mock-supabase-server.js अगर मौजूद है। असल project पर
// पहली बार चलाने से पहले ज़रूर --dry-run और फिर --execute --limit 3 जैसे
// छोटे batch से शुरू करें।
// ============================================================================

const { createClient } = require("@supabase/supabase-js");

const PORTAL_URL = process.env.PORTAL_URL || "https://jaigahoi.in";
const DELAY_MS = parseInt(process.env.INVITE_DELAY_MS || "700", 10); // Supabase email rate-limit से बचने के लिए

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const execute = process.argv.includes("--execute");
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : 50;

  if (!dryRun && !execute) {
    console.error("बताएं: --dry-run (सिर्फ़ गिनती/लिस्ट देखें) या --execute (असल में invite भेजें)।");
    console.error("Usage: node create-auth-users.js (--dry-run | --execute) [--limit N]");
    process.exit(1);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL और SUPABASE_SERVICE_ROLE_KEY env vars ज़रूरी हैं।");
    process.exit(1);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // सिर्फ़ वो persons जिनका अभी तक कोई auth account नहीं है, और जिनका email है
  // (census/pendingClaim rows में email हो भी सकता है, ना भी — बिना email के
  // invite भेजना ही मुमकिन नहीं, वो claim-flow से ही जुड़ेंगे बाद में)
  const { data: pending, error: fetchErr } = await admin
    .from("persons")
    .select("gahoi_id, name, email")
    .is("auth_uid", null)
    .not("email", "is", null)
    .order("gahoi_id", { ascending: true })
    .limit(limit);

  if (fetchErr) {
    console.error("persons table नहीं पढ़ पाया:", fetchErr.message);
    process.exit(1);
  }

  console.log(`${pending.length} members मिले जिनका अभी तक auth account नहीं है (limit=${limit})।`);

  if (dryRun) {
    pending.forEach((p) => console.log(`  [dry-run] ${p.gahoi_id}  ${p.name}  <${p.email}>`));
    console.log("\nकुछ भी नहीं भेजा गया (--dry-run)। असल में भेजने के लिए --execute इस्तेमाल करें।");
    return;
  }

  let invited = 0, failed = 0, relinked = 0;
  const failures = [];

  for (const person of pending) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(person.email, {
      data: { gahoi_id: person.gahoi_id, migrated: true },
      redirectTo: `${PORTAL_URL}/welcome.html`,
    });

    if (error) {
      // "already registered" — पहले से कोई और flow (या दोबारा-run) से auth
      // account बन चुका होगा, उसे ढूँढकर persons से link करने की कोशिश करते हैं
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("already") && msg.includes("registered")) {
        const existingId = await findAuthUserIdByEmail(admin, person.email);
        if (existingId) {
          const { error: linkErr } = await admin.from("persons")
            .update({ auth_uid: existingId }).eq("gahoi_id", person.gahoi_id);
          if (!linkErr) { relinked++; await sleep(DELAY_MS); continue; }
        }
      }
      failed++;
      failures.push({ gahoiId: person.gahoi_id, email: person.email, reason: error.message });
      console.error(`❌ ${person.gahoi_id} <${person.email}>: ${error.message}`);
      await sleep(DELAY_MS);
      continue;
    }

    const { error: linkErr } = await admin.from("persons")
      .update({ auth_uid: data.user.id }).eq("gahoi_id", person.gahoi_id);
    if (linkErr) {
      failed++;
      failures.push({ gahoiId: person.gahoi_id, email: person.email, reason: "auth बना पर persons.auth_uid link नहीं हो सका: " + linkErr.message });
      console.error(`⚠️  ${person.gahoi_id}: auth बना (${data.user.id}) पर link नहीं हो सका — मैन्युअल रूप से जोड़ें।`);
    } else {
      invited++;
      console.log(`✅ ${person.gahoi_id}  <${person.email}> — invite भेजा गया।`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n✅ ${invited} नए invite भेजे गए, ${relinked} पहले से मौजूद accounts से दोबारा जोड़े गए, ${failed} असफल रहे।`);
  if (failures.length) {
    console.log("\nअसफल rows (mैन्युअल review करें):");
    failures.forEach((f) => console.log(`  ${f.gahoiId} <${f.email}> — ${f.reason}`));
  }
  if (pending.length === limit) {
    console.log(`\nℹ️  --limit ${limit} पूरा हो गया — बाक़ी बचे members के लिए इसे दोबारा चलाएं (auth_uid`);
    console.log("   जिनका बन चुका वो अपने-आप skip होंगे, दोबारा invite नहीं भेजा जाएगा)।");
  }
}

// listUsers() में कोई सीधा "by email" filter नहीं है (Supabase Admin API की
// सीमा) — इसलिए pages में scan करना पड़ता है। सिर्फ़ "already registered" वाले
// rare case में चलता है, हर सामान्य invite पर नहीं — इसलिए महंगा होते हुए भी
// स्वीकार्य है
async function findAuthUserIdByEmail(admin, email) {
  const target = String(email).trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data || !data.users || data.users.length === 0) return null;
    const match = data.users.find((u) => String(u.email || "").toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 200) return null; // आख़िरी page
  }
  return null;
}

main().catch((e) => {
  console.error("अप्रत्याशित error:", e);
  process.exit(1);
});
