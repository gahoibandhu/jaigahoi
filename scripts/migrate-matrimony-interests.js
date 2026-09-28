#!/usr/bin/env node
// ============================================================================
// migrate-matrimony-interests.js
//
// पुरानी "MatInterest" Google Sheet का CSV export लेकर नए Postgres
// `matrimony_interests` table के लिए SQL INSERT statements बनाता है।
//
// ⚠️ इसे migrate-matrimony.js के बाद चलाएं, और उसी को दिया गया
// --id-map-out फ़ाइल यहाँ दें — legacy profile-ID (जैसे "m1234567890") नए uuid
// primary key से मेल नहीं खाता, इसलिए वही mapping चाहिए जो migrate-matrimony.js
// ने बनाई थी।
//
// इस्तेमाल:
//   node migrate-matrimony.js matrimony-export.csv members-export.csv \
//     --generate-census --id-map-out /tmp/mat-id-map.json > 0011_matrimony.sql
//   node migrate-matrimony-interests.js MatInterest-export.csv \
//     /tmp/mat-id-map.json members-export.csv > 0012_matrimony_interests.sql
//
// ── असल data पर मिली दो चीज़ें ────────────────────────────────────────────
// 1. कुछ ProfileID "M1251" जैसे छोटे-format में हैं (सामान्य `m<timestamp>` की
//    जगह) और Matrimony sheet में कहीं मौजूद ही नहीं — यानी वो profile कभी delete
//    हो चुका पर उसका पुराना interest-record सफ़ाई से नहीं हटा। ऐसे rows को
//    चुपचाप skip किया जाता है (टूटी FK के साथ insert करने की बजाय)।
// 2. legacy sheet में सिर्फ़ "interest" ही होता है (कोई अलग "shortlist" type
//    कभी बना ही नहीं — doMatInterest() हमेशा एक ही तरह का record डालता है),
//    इसलिए `type` हमेशा 'interest' है।
// 3. नए schema में mutual-match ख़ुद-ब-ख़ुद detect होता है (matrimony-interest
//    Edge Function का काम) — migration के वक़्त भी वही logic यहाँ दोहराई गई है:
//    अगर A ने B के profile में दिलचस्पी दिखाई हो, और B ने भी A के अपने profile
//    में (उसी दौरान) दिलचस्पी दिखाई हो, तो दोनों तरफ़ status='mutual' है।
// ============================================================================

const { readCsvFile, sqlStr, buildMembersLookup } = require("./_lib/csv-utils");
const fs = require("fs");

function main() {
  const interestCsvPath = process.argv[2];
  const idMapPath = process.argv[3];
  const membersCsvPath = process.argv[4];
  if (!interestCsvPath || !idMapPath || !membersCsvPath) {
    console.error("Usage: node migrate-matrimony-interests.js <matinterest-export.csv> <id-map.json> <members-export.csv>");
    process.exit(1);
  }

  const { dataRows, get } = readCsvFile(interestCsvPath);
  const idMap = JSON.parse(fs.readFileSync(idMapPath, "utf-8"));
  const lookup = buildMembersLookup(membersCsvPath);

  // legacy ProfileID केस-असंगत मिले (कुछ "M1251" uppercase, ज़्यादातर "m..."
  // lowercase) — id-map बनाते वक़्त हमेशा exact legacy ID (जो Matrimony sheet
  // के ID कॉलम में था) इस्तेमाल हुआ था, तो यहाँ exact-match पहले, फिर
  // case-insensitive fallback आज़माते हैं, ताकि सिर्फ़ केस-भिन्नता से valid
  // records skip ना हों
  const idMapLower = new Map(Object.keys(idMap).map((k) => [k.toLowerCase(), idMap[k]]));
  function resolveProfileUuid(legacyProfileId) {
    if (idMap[legacyProfileId]) return idMap[legacyProfileId];
    const lower = String(legacyProfileId || "").toLowerCase();
    return idMapLower.get(lower) || null;
  }

  // हर valid row को resolve करके पहले collect करते हैं — mutual-detection के
  // लिए दोनों दिशाओं का पूरा picture चाहिए, इसलिए पहले pass में सिर्फ़ पढ़ना,
  // insert-statements दूसरे pass में
  const resolved = [];
  let skippedNoSender = 0, skippedNoProfile = 0, skippedDup = 0;
  const seenPairs = new Set(); // "from|to" — unique(from_gahoi_id, to_profile_id, type) से पहले ख़ुद dedupe

  dataRows.forEach((row) => {
    const legacyProfileId = get(row, "ProfileID");
    const byEmail = get(row, "ByEmail");
    const legacyRowId = get(row, "ID");

    const fromGahoiId = lookup.byGahoiId(byEmail, "");
    if (!fromGahoiId) {
      skippedNoSender++;
      console.error(`⏭  Skipped interest ID=${legacyRowId} — भेजने वाला "${byEmail}" members-CSV में नहीं मिला।`);
      return;
    }

    const toProfileUuid = resolveProfileUuid(legacyProfileId);
    if (!toProfileUuid) {
      skippedNoProfile++;
      console.error(`⏭  Skipped interest ID=${legacyRowId} — profile "${legacyProfileId}" अब मौजूद नहीं (deleted या id-map में नहीं)।`);
      return;
    }

    const pairKey = fromGahoiId + "|" + toProfileUuid;
    if (seenPairs.has(pairKey)) { skippedDup++; return; }
    seenPairs.add(pairKey);

    resolved.push({
      fromGahoiId,
      toProfileUuid,
      time: get(row, "Time"),
      // mutual-detection के लिए: यह किसका profile है (ownerGahoiId), और यह
      // interest किसने भेजा (fromGahoiId) — नीचे reverse-lookup से मिलाया जाएगा
      ownerGahoiId: lookup.byGahoiId(get(row, "OwnerEmail"), ""),
    });
  });

  // mutual detection: अगर (A→B का profile) मौजूद है और (B→A का profile) भी
  // मौजूद है (दोनों resolved list में), तो दोनों 'mutual' हैं
  const pairSet = new Set(resolved.map((r) => r.fromGahoiId + "->" + r.ownerGahoiId));
  resolved.forEach((r) => {
    r.mutual = r.ownerGahoiId && pairSet.has(r.ownerGahoiId + "->" + r.fromGahoiId);
  });

  console.log("-- ============================================================================");
  console.log(`-- Auto-generated by migrate-matrimony-interests.js — ${dataRows.length} rows from ${interestCsvPath}`);
  console.log("-- ============================================================================\n");

  resolved.forEach((r) => {
    const status = r.mutual ? "mutual" : "pending";
    console.log(
      `insert into matrimony_interests (from_gahoi_id, to_profile_id, type, status, created_at) values (` +
      `${sqlStr(r.fromGahoiId)}, ${sqlStr(r.toProfileUuid)}, 'interest', ${sqlStr(status)}, ` +
      `${r.time ? sqlStr(r.time) : "now()"}) on conflict (from_gahoi_id, to_profile_id, type) do nothing;`
    );
  });

  const mutualCount = resolved.filter((r) => r.mutual).length;
  console.error(`\n✅ ${resolved.length} matrimony interests converted (${mutualCount} mutual-match निकले)।`);
  console.error(`   ${skippedNoSender} rows भेजने वाला ना मिलने से, ${skippedNoProfile} rows profile ना मिलने से, ${skippedDup} duplicate pairs छोड़े गए।`);
}

main();
