// ============================================================================
// scripts/_lib/csv-utils.js
// migrate-members.js / migrate-matrimony.js / migrate-mahasabha.js — तीनों में
// पहले अलग-अलग एक जैसा CSV-parser + SQL-escape कोड था (copy-paste)। यहाँ एक ही
// जगह — ताकि किसी एक में bug-fix हो और बाक़ी दो पुराने रह जाएँ, ऐसा ना हो।
// ============================================================================

const fs = require("fs");

// छोटा, पर सही (RFC4180-ish) CSV parser — quoted fields के अंदर comma संभालता है
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n"); // Windows-exported CSV normalize

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

function readCsvFile(path) {
  const text = fs.readFileSync(path, "utf-8");
  const rows = parseCsv(text);
  const headers = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1);
  const idx = (name) => headers.indexOf(name);
  const get = (row, name) => (idx(name) >= 0 ? row[idx(name)] : "");
  return { headers, dataRows, get };
}

// SQL-injection से बचने के लिए — सिर्फ़ single-quote escape (ये offline batch-script
// है, कोई user-facing query-building नहीं, फिर भी सावधानी ज़रूरी)
function sqlStr(val) {
  if (val === undefined || val === null || val === "") return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}
function sqlBool(val) {
  const v = String(val || "").toLowerCase().trim();
  return v === "true" || v === "yes" ? "true" : "false";
}
function sqlArray(csvStr) {
  if (!csvStr) return "'{}'";
  const items = String(csvStr).split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) return "'{}'";
  return "ARRAY[" + items.map(sqlStr).join(",") + "]";
}
function sqlJsonb(obj) {
  return "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";
}
function sqlNum(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? String(n) : "NULL";
}

// ---------------------------------------------------------------------------
// Birthday/Anniversary sanitize — legacy Code.gs के sanitizeDate() का text-CSV
// equivalent। असली production data में मिली एक genuine quality-issue (पहले से
// legacy-quirks.md में documented थी, Gahoi_Portal.xlsx export टेस्ट करने पर
// पहली बार वाक़ई सामने आई): Google Sheets ने कई "MM-DD" जैसी text-values को
// अपने-आप पूरी Date में बदल दिया — export में वो अब "2026-03-04 00:00:00" जैसी
// दिखती हैं, जिसका साल पूरी तरह बेमानी है (birthday का year कभी store ही नहीं
// हुआ था)। बिना इस सफ़ाई के raw string persons.bday में चला जाता और साल की वजह
// से ग़लत जानकारी बन जाती।
// ---------------------------------------------------------------------------
function sanitizeMMDD(val) {
  const s = String(val || "").trim();
  if (!s || s === "undefined" || s === "null") return "";
  if (/^\d{2}-\d{2}$/.test(s)) {
    const [m, d] = s.split("-").map(Number);
    return (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? s : "";
  }
  // "2026-03-04 00:00:00" / "2026-03-04T00:00:00.000Z" / "2026-03-04" जैसे —
  // UTC से पढ़ते हैं ताकि local-timezone की वजह से दिन ना खिसके (legacy भी
  // getUTCMonth/getUTCDate इस्तेमाल करता था इसी वजह से)
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) {
    const mm = parseInt(m2[2], 10), dd = parseInt(m2[3], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return String(mm).padStart(2, "0") + "-" + String(dd).padStart(2, "0");
    }
  }
  return ""; // पहचान में ना आए तो खाली — ग़लत date insert करने से बेहतर
}

// ---------------------------------------------------------------------------
// Members CSV से gahoi_id lookup बनाना (email/mobile → gahoi_id) — बिल्कुल वही
// assignment-algorithm जो migrate-members.js असली persons rows के लिए इस्तेमाल
// करता है (max-existing-GP-number + auto-increment for blanks, row-order में)।
// इसे एक ही जगह रखना ज़रूरी है: matrimony/mahasabha migration को वही GahoiId
// मिलने चाहिए जो असली members-migration ने उसी सदस्य को दिया — वरना
// matrimony_profiles.created_by / panchayat_memberships.member_gahoi_id की
// foreign-key insert-time पर टूट जाएगी (persons table में वो gahoi_id मौजूद
// ही नहीं होगा)।
//
// ⚠️ शर्त: migrate-matrimony.js / migrate-mahasabha.js को हमेशा वही
// members-export.csv दी जाए जो migrate-members.js को असली migration के वक़्त दी
// गई थी — फ़ाइल अलग या row-order बदला हुआ हुआ तो lookup ग़लत गाहोई-आईडी दे देगा।
// (हर तीनों script का console.error में यही चेतावनी भी छपती है — देखें नीचे।)
// ---------------------------------------------------------------------------
// migrate-members.js भी इसी को इस्तेमाल करती है (नीचे देखें) — GahoiId-assignment
// की logic अब सचमुच सिर्फ़ एक जगह है, दो अलग copy नहीं
function assignGahoiIdsForRows(dataRows, get) {
  let maxExistingNum = 0;
  dataRows.forEach((row) => {
    const g = get(row, "GahoiId");
    const m = g && g.match(/^GP(\d+)$/i);
    if (m) maxExistingNum = Math.max(maxExistingNum, parseInt(m[1], 10));
  });
  let nextAutoNum = maxExistingNum + 1;
  return dataRows.map((row) => {
    const existing = get(row, "GahoiId");
    if (existing && existing.trim()) return existing.trim();
    return "GP" + String(nextAutoNum++).padStart(8, "0");
  });
}

function buildMembersLookup(membersCsvPath) {
  const { dataRows, get } = readCsvFile(membersCsvPath);
  const gahoiIds = assignGahoiIdsForRows(dataRows, get);

  const byEmail = new Map();
  const byMobile = new Map();
  let maxNum = 0;
  dataRows.forEach((row, i) => {
    const name = get(row, "Name");
    if (!name || !name.trim()) return; // migrate-members.js जैसी ही empty-row skip

    const email = String(get(row, "Email") || "").trim().toLowerCase();
    const mobile = String(get(row, "Mobile") || "").trim();
    if (email) byEmail.set(email, gahoiIds[i]);
    if (mobile) byMobile.set(mobile, gahoiIds[i]);
    const m = gahoiIds[i].match(/^GP(\d+)$/i);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  });

  return {
    byGahoiId: (email, mobile) => {
      const e = String(email || "").trim().toLowerCase();
      if (e && byEmail.has(e)) return byEmail.get(e);
      const m = String(mobile || "").trim();
      if (m && byMobile.has(m)) return byMobile.get(m);
      return null;
    },
    count: dataRows.length,
    // migrate-matrimony.js जैसी scripts अगर census/pendingClaim persons rows ख़ुद
    // generate करना चाहें (जिनका कोई असली Members-row नहीं मिला), तो GahoiId
    // sequence यहीं से आगे बढ़ानी होगी — किसी collision से बचने के लिए
    nextAvailableNum: maxNum + 1,
  };
}

module.exports = {
  parseCsv, readCsvFile, sqlStr, sqlBool, sqlArray, sqlJsonb, sqlNum, sanitizeMMDD,
  assignGahoiIdsForRows, buildMembersLookup,
};
