#!/usr/bin/env node
// ============================================================================
// migrate-matrimony.js
//
// पुरानी "Matrimony" Google Sheet का CSV export लेकर नए Postgres
// `matrimony_profiles` table के लिए SQL INSERT statements बनाता है
// (भाग 10 handoff का अगला कदम, migrate-members.js के तुरंत बाद)।
//
// ── इस्तेमाल ──────────────────────────────────────────────────────────────
//   node migrate-matrimony.js <matrimony-export.csv> <members-export.csv> \
//     [--generate-census] > 0011_migrated_matrimony.sql
//
// ── ⚠️ असल production data (Gahoi_Portal.xlsx) पर चलाकर मिली एक बड़ी बात ──────
// 384 में से 294 matrimony rows (76%!) का creator email Members sheet में कहीं
// नहीं मिला। पहले लगा कि script का bug है, पर जाँच में साफ़ निकला — इन सभी 294
// का ID `migr_...` prefix से शुरू होता है (सामान्य profile ID हमेशा
// `m<timestamp>` होता है, Code.gs के doMatSubmit() से) — यानी ये किसी अलग bulk
// -import process से सीधे Matrimony sheet में डाले गए थे, बिना पहले उस व्यक्ति
// को Member के तौर पर register कराए (Code.gs का doMatSubmit() सामान्य flow में
// यह होने ही नहीं देता — `if(!req||req.status!=='Approved')return...`)।
//
// ये असल, ज़िंदा community-data है (सिर्फ़ अधूरा registration) — इसलिए `--generate
// -census` flag दिया गया है: बताने पर, हर orphaned creator के लिए matrimony row
// की अपनी जानकारी (Name/Mobile/City/Native/Akna) से एक **census/pendingClaim**
// persons row बना दी जाती है — बिल्कुल migration 0001 के डिज़ाइन किए गए
// mechanism जैसा (`auth_uid=NULL` + `claim_status='pendingClaim'` = "जब यह
// व्यक्ति असल में registration/login करे, तब यह record अपने-आप claim हो जाए",
// भाग 3 Phase C.1 की Claim Mechanism इसी के लिए बनी थी)। बिना यह flag दिए
// डिफ़ॉल्ट व्यवहार पहले जैसा ही है — चुपचाप skip, कोई नई persons row अपने-आप
// नहीं बनती (ये एक data-shape फ़ैसला है, GR को सोच-समझकर चुनना चाहिए)।

// ⚠️ <members-export.csv> वही file होनी चाहिए जो migrate-members.js को दी गई थी
// (और उसी क्रम में, बिना rows हटाए/जोड़े) — नीचे "createdBy resolution" नोट देखें
// कि क्यों यह ज़रूरी है।
//
// ── createdBy resolution (सबसे नाज़ुक हिस्सा) ────────────────────────────────
// पुरानी sheet में हर Matrimony row का `CreatedBy` (col B) सदस्य का **email**
// रखता है (Code.gs में `d.token` हमेशा email होता है), जबकि नए
// `matrimony_profiles.created_by` की foreign-key सीधे `persons(gahoi_id)` की
// ओर है। इसलिए हर row के लिए email → gahoi_id lookup ज़रूरी है — वही lookup जो
// migrate-members.js ने असल में उस सदस्य को दिया (देखें
// scripts/_lib/csv-utils.js का buildMembersLookup, जो बिल्कुल वही
// GahoiId-assignment algorithm दोहराता है)। जिस row का creator members-CSV में
// नहीं मिलता (या तो सदस्य delete हो चुका, या email mismatch), उसे **skip** किया
// जाता है, चुपचाप ग़लत/टूटी हुई FK के साथ insert नहीं होता — console.error में
// हर skipped row का ID साफ़ छपता है ताकि GR manually review कर सकें।
// ============================================================================

const crypto = require("crypto");
const fs = require("fs");
const { readCsvFile, sqlStr, sqlJsonb, buildMembersLookup } = require("./_lib/csv-utils");

function main() {
  const matCsvPath = process.argv[2];
  const membersCsvPath = process.argv[3];
  const generateCensus = process.argv.includes("--generate-census");
  const idMapOutIdx = process.argv.indexOf("--id-map-out");
  const idMapOutPath = idMapOutIdx >= 0 ? process.argv[idMapOutIdx + 1] : null;
  if (!matCsvPath || !membersCsvPath) {
    console.error("Usage: node migrate-matrimony.js <matrimony-export.csv> <members-export.csv> [--generate-census] [--id-map-out <path>]");
    process.exit(1);
  }

  const { dataRows, get, headers } = readCsvFile(matCsvPath);
  const lookup = buildMembersLookup(membersCsvPath);
  let nextCensusNum = lookup.nextAvailableNum;
  // matrimony_profiles.id डिफ़ॉल्ट gen_random_uuid() से आता — पर matrimony_interests
  // migration (MatInterest sheet) को पुराने profile-ID (जैसे "m123...") से नए uuid
  // की मैपिंग चाहिए होगी, इसलिए यहीं client-side से UUID assign करते हैं
  // (--id-map-out दिए जाने पर legacyId→uuid JSON output होती है)
  const legacyToUuid = new Map();

  // ── पुराने sheet में col 56/57/58/59 (TierStartDate/LastEditedAt/JobCompany/
  //    JobCity) के नाम setupMatHeaders() की HEADERS list में कभी जोड़े ही नहीं
  //    गए थे (Code.gs में सीधे positional index से लिखे/पढ़े जाते हैं — देखें
  //    doMatList का r[55]/r[56]/r[57]/r[58])। इसलिए अगर named-lookup से नहीं
  //    मिलते, position से (0-indexed: 55,56,57,58) पढ़ते हैं — CSV column-order
  //    बदला ना हो, यही एक भरोसा है यहाँ।
  const idx = (name) => headers.indexOf(name);
  function getPositionalFallback(row, name, posIndex) {
    const byName = get(row, name);
    if (byName) return byName;
    if (idx(name) === -1 && row[posIndex] !== undefined) return row[posIndex];
    return byName;
  }
  if (idx("TierStartDate") === -1 || idx("LastEditedAt") === -1 || idx("JobCompany") === -1 || idx("JobCity") === -1) {
    console.error("⚠️  TierStartDate/LastEditedAt/JobCompany/JobCity headers नाम से नहीं मिले —");
    console.error("   column-position (56वां/57वां/58वां/59वां) से पढ़ रहे हैं। CSV में column-order");
    console.error("   पुरानी sheet जैसा ही होना चाहिए, वरना ये चार fields ग़लत आ सकते हैं (बाक़ी सब safe है)।");
  }

  console.log("-- ============================================================================");
  console.log(`-- Auto-generated by migrate-matrimony.js — ${dataRows.length} rows from ${matCsvPath}`);
  console.log("-- चलाने से पहले पूरा review करें, ख़ासकर स्किप हुई rows वाला stderr वार्निंग देखें।");
  console.log("-- ============================================================================\n");

  let inserted = 0, skippedEmpty = 0, skippedNoOwner = 0, censusGenerated = 0;
  // असल data पर टेस्ट करने पर मिला: कुछ orphaned rows का mobile एक-दूसरे से टकराता
  // है (जैसे एक ही असली व्यक्ति ने दो अलग emails से दो बार matrimony bio-data
  // जमा किया हो) — सिर्फ़ email से dedupe करना काफ़ी नहीं, persons.mobile पर भी
  // unique index है (migration 0006), इसलिए दोनों तरफ़ से track करना ज़रूरी
  const censusByEmail = new Map();
  const censusByMobile = new Map();

  dataRows.forEach((row) => {
    const name = get(row, "Name");
    if (!name || !name.trim()) { skippedEmpty++; return; }

    const legacyId = get(row, "ID");
    const createdByEmail = get(row, "CreatedBy");
    const mobile = get(row, "Mobile");
    let ownerGahoiId = lookup.byGahoiId(createdByEmail, mobile);

    if (!ownerGahoiId && generateCensus) {
      const emailKey = String(createdByEmail || "").trim().toLowerCase();
      const mobileKey = String(mobile || "").trim();
      ownerGahoiId = (emailKey && censusByEmail.get(emailKey))
        || (mobileKey && censusByMobile.get(mobileKey))
        || null;

      if (!ownerGahoiId) {
        ownerGahoiId = "GP" + String(nextCensusNum++).padStart(8, "0");
        if (emailKey) censusByEmail.set(emailKey, ownerGahoiId);
        if (mobileKey) censusByMobile.set(mobileKey, ownerGahoiId);
        console.log(
          `insert into persons (gahoi_id, name, email, mobile, city, native, akna, status, claim_status) values (` +
          `${sqlStr(ownerGahoiId)}, ${sqlStr(name)}, ${sqlStr(createdByEmail)}, ${sqlStr(mobile)}, ` +
          `${sqlStr(get(row, "City"))}, ${sqlStr(get(row, "Native"))}, ${sqlStr(get(row, "Akna"))}, ` +
          `'Approved', 'pendingClaim');`
        );
        censusGenerated++;
      }
    }

    if (!ownerGahoiId) {
      skippedNoOwner++;
      console.error(`⏭  Skipped matrimony ID=${legacyId} (${name}) — creator "${createdByEmail}" members-CSV में नहीं मिला।`);
      return;
    }

    let photos = [];
    try {
      const parsed = JSON.parse(get(row, "Photos") || "[]");
      if (Array.isArray(parsed)) photos = parsed.filter(Boolean);
    } catch { /* पुराना data कभी-कभी malformed/खाली होता है */ }
    const primaryPhoto = get(row, "Photo");
    if (!photos.length && primaryPhoto) photos = [primaryPhoto];

    const cols = [
      "id", "created_by", "status", "profile_for", "gender", "marital", "name", "dob",
      "height", "complexion", "manglik", "education", "occupation", "income",
      "city", "native", "gotra", "akna", "father", "father_occ", "mother", "mama",
      "brothers", "sisters", "mobile", "contact_name", "pref_edu", "pref_age",
      "pref_city", "pref_other", "about", "photo", "address", "birth_time",
      "birth_city", "rashi", "gan", "nakshatra", "dadaji", "nanaji", "tau", "bua",
      "chacha", "mausi", "didi", "dadiji", "naniji", "tier", "photos",
      "photo_privacy", "valid_until", "tier_start_date", "expiry_notified",
      "job_company", "job_city", "deleted_at", "deleted_by", "created_at", "edited_at",
    ];

    const validUntil = get(row, "ValidUntil");
    const deletedAt = get(row, "DeletedAt");
    const tierStartDate = getPositionalFallback(row, "TierStartDate", 55);
    const editedAt = getPositionalFallback(row, "LastEditedAt", 56);
    const jobCompany = getPositionalFallback(row, "JobCompany", 57);
    const jobCity = getPositionalFallback(row, "JobCity", 58);
    const timestamp = get(row, "Timestamp");
    const newUuid = crypto.randomUUID();
    legacyToUuid.set(legacyId, newUuid);

    const vals = [
      sqlStr(newUuid), sqlStr(ownerGahoiId), sqlStr(get(row, "Status") || "Approved"), sqlStr(get(row, "ProfileFor")),
      sqlStr(get(row, "Gender")), sqlStr(get(row, "Marital")), sqlStr(name), sqlStr(get(row, "DOB")),
      sqlStr(get(row, "Height")), sqlStr(get(row, "Complexion")), sqlStr(get(row, "Manglik")),
      sqlStr(get(row, "Education")), sqlStr(get(row, "Occupation")), sqlStr(get(row, "Income")),
      sqlStr(get(row, "City")), sqlStr(get(row, "Native")), sqlStr(get(row, "Gotra")), sqlStr(get(row, "Akna")),
      sqlStr(get(row, "Father")), sqlStr(get(row, "FatherOcc")), sqlStr(get(row, "Mother")), sqlStr(get(row, "Mama")),
      sqlStr(get(row, "Brothers")), sqlStr(get(row, "Sisters")), sqlStr(mobile), sqlStr(get(row, "ContactName")),
      sqlStr(get(row, "PrefEdu")), sqlStr(get(row, "PrefAge")), sqlStr(get(row, "PrefCity")), sqlStr(get(row, "PrefOther")),
      sqlStr(get(row, "About")), sqlStr(primaryPhoto), sqlStr(get(row, "Address")), sqlStr(get(row, "BirthTime")),
      sqlStr(get(row, "BirthCity")), sqlStr(get(row, "Rashi")), sqlStr(get(row, "Gan")), sqlStr(get(row, "Nakshatra")),
      sqlStr(get(row, "Dadaji")), sqlStr(get(row, "Nanaji")), sqlStr(get(row, "Tau")), sqlStr(get(row, "Bua")),
      sqlStr(get(row, "Chacha")), sqlStr(get(row, "Mausi")), sqlStr(get(row, "Didi")), sqlStr(get(row, "Dadiji")),
      sqlStr(get(row, "Naniji")), sqlStr(get(row, "Tier") || "Gold"), sqlJsonb(photos),
      sqlStr(get(row, "PhotoPrivacy") || "all"), validUntil ? sqlStr(validUntil) : "NULL",
      tierStartDate ? sqlStr(tierStartDate) : "NULL", sqlStr(get(row, "ExpiryNotified")),
      sqlStr(jobCompany), sqlStr(jobCity), deletedAt ? sqlStr(deletedAt) : "NULL",
      sqlStr(get(row, "DeletedBy")), timestamp ? sqlStr(timestamp) : "now()",
      editedAt ? sqlStr(editedAt) : (timestamp ? sqlStr(timestamp) : "now()"),
    ];

    console.log(`insert into matrimony_profiles (${cols.join(", ")}) values (${vals.join(", ")});`);
    inserted++;
  });

  console.error(`\n✅ ${inserted} matrimony profiles converted।`);
  console.error(`   ${skippedEmpty} खाली rows छोड़े गए, ${skippedNoOwner} rows creator ना मिलने से छोड़े गए (ऊपर देखें)।`);
  if (generateCensus) console.error(`   ${censusGenerated} नई census/pendingClaim persons rows बनाई गईं (--generate-census)।`);

  if (idMapOutPath) {
    const mapObj = Object.fromEntries(legacyToUuid);
    fs.writeFileSync(idMapOutPath, JSON.stringify(mapObj, null, 2));
    console.error(`\n📝 legacyId→uuid mapping (${legacyToUuid.size} entries) लिखी गई: ${idMapOutPath}`);
    console.error("   इसे migrate-matrimony-interests.js को दें।");
  } else {
    console.error("\n⚠️  matrimony_interests (MatInterest sheet) migrate करने के लिए --id-map-out <path>");
    console.error("   देकर इस script को दोबारा चलाएं, फिर वो path migrate-matrimony-interests.js को दें।");
  }
}

main();
