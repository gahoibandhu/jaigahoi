#!/usr/bin/env node
// ============================================================================
// migrate-content.js
//
// छोटी content sheets — BusinessDir, JobBoard, CommunityEvents, Gallery,
// Dharmshala, Magazine, Offers — के लिए एक ही script (हर एक अपनी अलग तालिका
// में, पर सब मिलाकर बहुत छोटी हैं, इसलिए अलग-अलग 7 फ़ाइलें बनाने की बजाय एक ही
// जगह — इस्तेमाल हर बार सिर्फ़ वो flags दें जिस sheet का CSV आपके पास है)।
//
// ⚠️ offers table migration 0011 में जोड़ा गया — पहले schema में सिरे से मौजूद
// ही नहीं था (README में ग़लती से "पहले से है" लिखा गया था, यहीं पकड़ में आया)।
//
// इस्तेमाल (जो चाहिए वो flag दें, बाक़ी छोड़ दें):
//   node migrate-content.js --members members-export.csv \
//     --business BusinessDir.csv --jobs JobBoard.csv \
//     --events CommunityEvents.csv --gallery Gallery.csv \
//     --dharmshala Dharmshala.csv --magazines Magazine.csv \
//     --offers Offers.csv > 0015_migrated_content.sql
//
// business_listings/jobs/offers का posted_by legacy sheet में email है (Code.gs
// के d.token जैसा — matrimony/CreatedBy वाली ही situation), इसलिए --members
// ज़रूरी है जब भी --business/--jobs/--offers दिया जाए (लौकअप के लिए)।
// gallery/dharmshala/community_events/magazines में कोई FK नहीं (posted_by/
// uploader सिर्फ़ display-नाम text है, persons से जुड़ा नहीं) — --members
// इनके लिए ज़रूरी नहीं।
// ============================================================================

const { readCsvFile, sqlStr, buildMembersLookup } = require("./_lib/csv-utils");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function migrateBusiness(path, lookup) {
  const { dataRows, get } = readCsvFile(path);
  let inserted = 0, skipped = 0;
  dataRows.forEach((row) => {
    const firm = get(row, "Firm");
    if (!firm || !firm.trim()) return;
    const postedByEmail = get(row, "PostedBy");
    const gahoiId = lookup ? lookup.byGahoiId(postedByEmail, get(row, "Mobile")) : null;
    if (!gahoiId) { skipped++; console.error(`⏭  Business "${firm}" — poster "${postedByEmail}" members-CSV में नहीं मिला।`); return; }
    const deletedAt = get(row, "DeletedAt");
    console.log(
      `insert into business_listings (posted_by, firm, industry, person, desig, address, pincode, city, ` +
      `maps, mobile, email, keywords, photo, posted_at, edited_at, deleted_at) values (` +
      `${sqlStr(gahoiId)}, ${sqlStr(firm)}, ${sqlStr(get(row, "Industry"))}, ${sqlStr(get(row, "Person"))}, ` +
      `${sqlStr(get(row, "Desig"))}, ${sqlStr(get(row, "Address"))}, ${sqlStr(get(row, "Pincode"))}, ` +
      `${sqlStr(get(row, "City"))}, ${sqlStr(get(row, "Maps"))}, ${sqlStr(get(row, "Mobile"))}, ` +
      `${sqlStr(get(row, "Email"))}, ${sqlStr(get(row, "Keywords"))}, ${sqlStr(get(row, "Photo"))}, ` +
      `${get(row, "Posted") ? sqlStr(get(row, "Posted")) : "now()"}, ` +
      `${get(row, "EditedAt") ? sqlStr(get(row, "EditedAt")) : (get(row, "Posted") ? sqlStr(get(row, "Posted")) : "now()")}, ` +
      `${deletedAt ? sqlStr(deletedAt) : "NULL"});`
    );
    inserted++;
  });
  console.error(`✅ business_listings: ${inserted} inserted, ${skipped} skipped (poster ना मिला)।`);
}

function migrateJobs(path, lookup) {
  const { dataRows, get } = readCsvFile(path);
  let inserted = 0, skipped = 0;
  dataRows.forEach((row) => {
    const title = get(row, "Title");
    if (!title || !title.trim()) return;
    const postedByEmail = get(row, "PostedBy");
    const gahoiId = lookup ? lookup.byGahoiId(postedByEmail, get(row, "Mobile")) : null;
    if (!gahoiId) { skipped++; console.error(`⏭  Job "${title}" — poster "${postedByEmail}" members-CSV में नहीं मिला।`); return; }
    console.log(
      `insert into jobs (posted_by, title, company, location, type, salary, exp, description, mobile, email, posted_at) values (` +
      `${sqlStr(gahoiId)}, ${sqlStr(title)}, ${sqlStr(get(row, "Company"))}, ${sqlStr(get(row, "Location"))}, ` +
      `${sqlStr(get(row, "Type"))}, ${sqlStr(get(row, "Salary"))}, ${sqlStr(get(row, "Exp"))}, ` +
      `${sqlStr(get(row, "Desc"))}, ${sqlStr(get(row, "Mobile"))}, ${sqlStr(get(row, "Email"))}, ` +
      `${get(row, "Posted") ? sqlStr(get(row, "Posted")) : "now()"});`
    );
    inserted++;
  });
  console.error(`✅ jobs: ${inserted} inserted, ${skipped} skipped (poster ना मिला)।`);
}

function migrateEvents(path) {
  const { dataRows, get } = readCsvFile(path);
  let inserted = 0;
  dataRows.forEach((row) => {
    const title = get(row, "Title");
    if (!title || !title.trim()) return;
    console.log(
      `insert into community_events (title, description, event_date, image) values (` +
      `${sqlStr(title)}, ${sqlStr(get(row, "Description"))}, ` +
      `${get(row, "Date") ? sqlStr(get(row, "Date")) : "NULL"}, ${sqlStr(get(row, "Image"))});`
    );
    inserted++;
  });
  console.error(`✅ community_events: ${inserted} inserted।`);
}

function migrateGallery(path) {
  const { dataRows, get } = readCsvFile(path);
  let inserted = 0, skipped = 0;
  dataRows.forEach((row) => {
    const url = get(row, "URL");
    if (!url || !url.trim()) { skipped++; return; }
    console.log(
      `insert into gallery (url, caption, album, uploader, created_at) values (` +
      `${sqlStr(url)}, ${sqlStr(get(row, "Caption"))}, ${sqlStr(get(row, "Album") || "General")}, ` +
      `${sqlStr(get(row, "Uploader"))}, ${get(row, "Timestamp") ? sqlStr(get(row, "Timestamp")) : "now()"});`
    );
    inserted++;
  });
  console.error(`✅ gallery: ${inserted} inserted, ${skipped} खाली-URL rows छोड़े गए।`);
}

function migrateDharmshala(path) {
  const { dataRows, get } = readCsvFile(path);
  let inserted = 0, skipped = 0;
  dataRows.forEach((row) => {
    const name = get(row, "Name");
    const city = get(row, "City");
    if (!name || !city) { skipped++; return; } // doGetDharm() भी यही filter करता है
    console.log(
      `insert into dharmshala (state, city, name, address, person, contact, maps, posted_at) values (` +
      `${sqlStr(get(row, "State"))}, ${sqlStr(city)}, ${sqlStr(name)}, ${sqlStr(get(row, "Address"))}, ` +
      `${sqlStr(get(row, "Person"))}, ${sqlStr(get(row, "Contact"))}, ${sqlStr(get(row, "Maps"))}, ` +
      `${get(row, "Posted") ? sqlStr(get(row, "Posted")) : "now()"});`
    );
    inserted++;
  });
  console.error(`✅ dharmshala: ${inserted} inserted, ${skipped} skipped (नाम/शहर ग़ायब)।`);
}

function migrateMagazines(path) {
  const { dataRows, get } = readCsvFile(path);
  let inserted = 0;
  dataRows.forEach((row) => {
    const title = get(row, "Title");
    if (!title || !title.trim()) return;
    console.log(
      `insert into magazines (title, description, cover_image, file_url, month, year, posted_at, posted_by) values (` +
      `${sqlStr(title)}, ${sqlStr(get(row, "Description"))}, ${sqlStr(get(row, "CoverImage"))}, ` +
      `${sqlStr(get(row, "FileUrl"))}, ${sqlStr(get(row, "Month"))}, ${sqlStr(get(row, "Year"))}, ` +
      `${get(row, "Posted") ? sqlStr(get(row, "Posted")) : "now()"}, ${sqlStr(get(row, "PostedBy"))});`
    );
    inserted++;
  });
  console.error(`✅ magazines: ${inserted} inserted।`);
}

function migrateOffers(path, lookup) {
  const { dataRows, get } = readCsvFile(path);
  let inserted = 0, skipped = 0;
  dataRows.forEach((row) => {
    const title = get(row, "Title");
    if (!title || !title.trim()) return;
    const postedByEmail = get(row, "PostedBy");
    const gahoiId = lookup ? lookup.byGahoiId(postedByEmail, get(row, "Mobile")) : null;
    if (!gahoiId) { skipped++; console.error(`⏭  Offer "${title}" — poster "${postedByEmail}" members-CSV में नहीं मिला।`); return; }
    const deletedAt = get(row, "DeletedAt");
    console.log(
      `insert into offers (posted_by, title, details, image, cities, mobile, valid_till, posted_at, deleted_at) values (` +
      `${sqlStr(gahoiId)}, ${sqlStr(title)}, ${sqlStr(get(row, "Details"))}, ${sqlStr(get(row, "Image"))}, ` +
      `${sqlStr(get(row, "Cities"))}, ${sqlStr(get(row, "Mobile"))}, ` +
      `${get(row, "ValidTill") ? sqlStr(get(row, "ValidTill")) : "NULL"}, ` +
      `${get(row, "Posted") ? sqlStr(get(row, "Posted")) : "now()"}, ${deletedAt ? sqlStr(deletedAt) : "NULL"});`
    );
    inserted++;
  });
  console.error(`✅ offers: ${inserted} inserted, ${skipped} skipped (poster ना मिला)।`);
}

function main() {
  const membersPath = arg("members");
  const lookup = membersPath ? buildMembersLookup(membersPath) : null;

  console.log("-- ============================================================================");
  console.log("-- Auto-generated by migrate-content.js");
  console.log("-- ============================================================================\n");

  const business = arg("business");
  const jobs = arg("jobs");
  const events = arg("events");
  const gallery = arg("gallery");
  const dharmshala = arg("dharmshala");
  const magazines = arg("magazines");
  const offers = arg("offers");

  if (business) { if (!lookup) { console.error("--business के लिए --members ज़रूरी है (posted_by email lookup)।"); process.exit(1); } migrateBusiness(business, lookup); }
  if (jobs) { if (!lookup) { console.error("--jobs के लिए --members ज़रूरी है।"); process.exit(1); } migrateJobs(jobs, lookup); }
  if (events) migrateEvents(events);
  if (gallery) migrateGallery(gallery);
  if (dharmshala) migrateDharmshala(dharmshala);
  if (magazines) migrateMagazines(magazines);
  if (offers) { if (!lookup) { console.error("--offers के लिए --members ज़रूरी है।"); process.exit(1); } migrateOffers(offers, lookup); }

  if (!business && !jobs && !events && !gallery && !dharmshala && !magazines && !offers) {
    console.error("कम-से-कम एक flag दें: --business/--jobs/--events/--gallery/--dharmshala/--magazines/--offers");
    process.exit(1);
  }
}

main();
