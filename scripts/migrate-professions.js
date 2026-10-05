#!/usr/bin/env node
// ============================================================================
// migrate-professions.js  — Members sheet ke Profession/Designation/Keywords text se
// person_professions tags SUGGEST karta hai (migration 0019 ke baad chalao).
//
// Rules (jaan-boojh kar sakht):
//  * Tags source='auto-migration', verification='unverified', member_confirmed=false hote hain —
//    member apne "मेरे Professional Tags" page par badal/hata sakta hai.
//  * POLITICIAN kabhi auto-tag nahi hota (sensitive). Sirf stderr mein "dhyan do" list aati hai,
//    taaki Admin us member se poochh kar ya khud confirm karwa kar tag kare.
//  * Ek text kai category match kar sakta hai (jaise "Doctor + Social worker") — sab lagte hain,
//    sirf "Software Engineer" jaisa text IT mein jaata hai, Engineer mein nahi (duplicate se bachne ke liye).
//  * Idempotent: dobara chalane par duplicates nahi banate (ON CONFLICT DO NOTHING).
//
// Use:
//   node migrate-professions.js members-export.csv > 0020_migrated_professions.sql
//   node migrate-professions.js members-export.csv --report   # sirf stderr summary, SQL nahi
// ============================================================================
const { readCsvFile, sqlStr, buildMembersLookup } = require("./_lib/csv-utils");

const csvPath = process.argv[2];
const reportOnly = process.argv.includes("--report");

// [slug, regex] — English words word-boundary se, Hindi plain contains
const RULES = [
  ["doctor",        /\b(dr|doctor|physician|surgeon|mbbs|m\.d|m\.s|cardiolog\w*|gynae\w*|paediatric\w*|pediatric\w*|orthopaed\w*|dermatolog\w*|radiolog\w*|neurolog\w*|nephrolog\w*|oncolog\w*)\b|डॉक्टर|चिकित्सक|डाक्टर/i],
  ["dentist",       /\b(dentist|dental|bds|mds)\b|दंत/i],
  ["ayush",         /\b(vaidya|ayurved\w*|homeo\w*|bams|bhms|unani)\b|वैद्य|आयुर्वेद|होम्योपैथ/i],
  ["pharmacist",    /\b(pharmac\w*|chemist|b\.?pharm|d\.?pharm|medical store)\b|फार्मा|फार्मेसी/i],
  ["it_professional",/\b(software|developer|programmer|web ?design\w*|it professional|it consultant|data ?scien\w*|devops|full ?stack|cyber)\b|आईटी|सॉफ्टवेयर|सॉफ़्टवेयर/i],
  ["engineer",      /\b(engineer\w*|b\.?tech|m\.?tech|b\.?e\.?|civil|mechanical|electrical|electronics)\b|इंजीनियर|इंजिनियर/i],
  ["architect",     /\b(architect\w*)\b|आर्किटेक्ट/i],
  ["advocate",      /\b(advocate|lawyer|barrister|llb|llm|legal practi\w*)\b|वकील|अधिवक्ता|एडवोकेट/i],
  ["judiciary",     /\b(judge|magistrate|judicial)\b|न्यायाधीश|मजिस्ट्रेट/i],
  ["ca",            /\b(ca|c\.a|chartered accountant|chartered acc\w*)\b|चार्टर्ड|सीए/i],
  ["cs_cma",        /\b(company secretary|cma|cost accountant|icsi|icmai)\b/i],
  ["banker",        /\b(bank\w*|insurance|lic|sbi|pnb)\b|बैंक|बीमा/i],
  ["teacher",       /\b(teacher|professor|lecturer|principal|headmaster|tutor|coaching)\b|शिक्षक|अध्यापक|प्रोफेसर|प्राचार्य|व्याख्याता/i],
  ["researcher",    /\b(scientist|researcher|ph\.?d|research)\b|वैज्ञानिक|शोध/i],
  ["govt_officer",  /\b(ias|ips|pcs|ifs|ies|govt|government|tehsildar|deputy collector|collector|sdm|patwari|clerk|revenue)\b|सरकारी|तहसीलदार|पटवारी/i],
  ["police_defence",/\b(police|army|navy|air ?force|defen[cs]e|crpf|bsf|cisf|soldier)\b|पुलिस|सेना|फौज/i],
  ["social_worker", /\b(social worker|ngo|samaj ?sevi|social service)\b|समाजसेवी|समाज सेवा|समाजसेवा/i],
  ["businessman",   /\b(business\w*|trader|trading|shop(keeper)?|dukaa?n|manufactur\w*|industrialist|contractor|dealer|wholesale\w*|retail\w*|distributor|proprietor|owner)\b|व्यापार|व्यापारी|दुकान|उद्योग|बिजनेस|बिज़नेस/i],
  ["media_arts",    /\b(journalist|reporter|artist|singer|actor|musician|sportsman|athlete|photographer|editor)\b|पत्रकार|कलाकार|खिलाड़ी|गायक/i],
  ["farmer",        /\b(farmer|agricultur\w*|kheti|farming)\b|किसान|कृषि|खेती/i],
  ["religious",     /\b(pandit|priest|astrolog\w*|jyotish\w*|purohit|pujari)\b|पंडित|ज्योतिष|पुजारी|पुरोहित/i],
];
// Sensitive — kabhi auto-tag nahi, sirf report
const POLITICAL = /\b(mla|mp|sarpanch|parshad|councillor|corporator|mayor|politic\w*|neta|minister|chairman of nagar|zila panchayat)\b|विधायक|सांसद|सरपंच|पार्षद|नेता|राजनीत|मंत्री|महापौर/i;

function classify(text) {
  const hits = [];
  for (const [slug, re] of RULES) if (re.test(text)) hits.push(slug);
  // "Software Engineer" -> sirf IT (Engineer nahi)
  if (hits.includes("it_professional") && hits.includes("engineer")) hits.splice(hits.indexOf("engineer"), 1);
  return hits;
}
module.exports = { classify, POLITICAL, RULES };

if (require.main === module) {
  if (!csvPath) { console.error("Usage: node migrate-professions.js members-export.csv [--report]"); process.exit(1); }
  const { dataRows, get } = readCsvFile(csvPath);
  const lookup = buildMembersLookup(csvPath);
  const counts = {}; let people = 0, matchedPeople = 0, noId = 0, tags = 0;
  const politicalWatch = [], unmatchedSamples = [];
  dataRows.forEach((row) => {
    const name = (get(row, "Name") || "").trim();
    if (!name) return;
    people++;
    const gid = lookup.byGahoiId(get(row, "Email"), get(row, "Mobile"));
    if (!gid) { noId++; return; }
    const prof = (get(row, "Profession") || "").trim();
    const desig = (get(row, "Designation") || "").trim();
    const kw = (get(row, "Keywords") || "").trim();
    const text = [prof, desig, kw].filter(Boolean).join(" | ");
    if (!text) return;
    if (POLITICAL.test(text)) politicalWatch.push(`${gid} ${name} — "${text.slice(0, 80)}"`);
    const hits = classify(text);
    if (!hits.length) { if (unmatchedSamples.length < 15) unmatchedSamples.push(`${gid} "${text.slice(0, 60)}"`); return; }
    matchedPeople++;
    // Title me political shabd kabhi nahi (sensitive) — warna "Sarpanch" jaisa label doosre tag ke title se leak ho jata
    const title = [desig, prof].find((t) => t && !POLITICAL.test(t)) || "";
    const titleOut = title.slice(0, 80);
    hits.forEach((slug) => {
      counts[slug] = (counts[slug] || 0) + 1; tags++;
      if (reportOnly) return;
      console.log(
        `insert into person_professions (person_gahoi_id, category_slug, title, visibility, source, member_confirmed, verification_status) ` +
        `select ${sqlStr(gid)}, ${sqlStr(slug)}, ${sqlStr(titleOut)}, 'members', 'auto-migration', false, 'unverified' ` +
        `where exists (select 1 from persons where gahoi_id = ${sqlStr(gid)}) on conflict do nothing;`
      );
    });
  });
  console.error(`\n✅ ${people} members padhe · ${matchedPeople} ke liye tag mile · ${tags} tags${reportOnly ? " (report-only, SQL nahi)" : ""} · ${noId} ka GahoiId nahi mila`);
  Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach((k) => console.error(`   ${k.padEnd(16)} ${counts[k]}`));
  if (politicalWatch.length) {
    console.error(`\n⚠️  ${politicalWatch.length} member(s) ke text mein political/jan-pratinidhi jaisa shabd — AUTO-TAG NAHI kiya (sensitive). Admin se confirm karwa kar admin-professions.html se tag karo:`);
    politicalWatch.forEach((l) => console.error("   • " + l));
  }
  if (unmatchedSamples.length) {
    console.error(`\nℹ️  Match nahi hue (namune) — rules mein shabd jodne ho to batao:`);
    unmatchedSamples.forEach((l) => console.error("   · " + l));
  }
}
