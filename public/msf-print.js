// ============================================================================
// msf-print.js — Mahasabha membership form: print + payment-CSV helpers
// पुराने index.html के msfBuildPrintDocV2 (A4 print form) का verbatim port।
// Layout वही रखा है (header, फोटो, विवरण, declaration, कार्यालय-उपयोग, पावती)।
// सिर्फ़ data-adapter नया है: panchayat_memberships row + persons row -> legacy shape।
// ============================================================================

const GP_MSF_CSS = `.msf-pr-page { padding:8px 0;page-break-after:always;font-size:12px;color:#111;line-height:1.55 }
.msf-print-wrap { font-family: 'Noto Sans', 'Lohit Devanagari', Arial, sans-serif; font-size: 12px; color: #111; line-height: 1.6; max-width: 740px; margin: 0 auto; padding: 12px; background: #fff; }
.msf-pr-header { text-align: center; border-bottom: 2.5px double #7a1f3d; padding-bottom: 10px; margin-bottom: 12px; }
.msf-pr-header h2 { font-size: 16px; font-weight: 900; color: #7a1f3d; margin: 0; }
.msf-pr-header p { font-size: 10px; color: #555; margin: 2px 0 0; }
.msf-pr-badge { display: inline-block; background: #7a1f3d; color: #fff; border-radius: 3px; padding: 3px 14px; font-size: 11px; font-weight: 700; margin-top: 7px; }
.msf-pr-photo { float: right; margin: 0 0 8px 14px; width: 80px; height: 90px; object-fit: cover; border: 1px solid #ccc; border-radius: 3px; }
.msf-pr-section-hdr { background: #7a1f3d; color: #fff; text-align: center; padding: 4px; font-weight: 700; font-size: 11px; border-radius: 3px; margin: 10px 0 6px; }
.msf-pr-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 10.5px; }
.msf-pr-table td { padding: 3px 6px 3px 0; vertical-align: bottom; }
.msf-pr-field { border-bottom: 1px solid #999; min-height: 16px; display: block; padding: 2px 0; }
.msf-pr-field-lbl { font-size: 9.5px; color: #666; display: block; margin-bottom: 1px; }
.msf-pr-decl { border: 1px solid #ddd; border-radius: 3px; padding: 7px; font-size: 10px; margin-bottom: 8px; line-height: 1.7; }
.msf-pr-sig-row { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 10px; }
.msf-pr-sig-img { height: 50px; max-width: 160px; object-fit: contain; display: block; }
.msf-pr-office { border: 1px solid #ddd; border-radius: 3px; padding: 7px; font-size: 9.5px; color: #555; line-height: 2; }
.msf-pr-pavti { border: 1px solid #ddd; border-radius: 3px; padding: 7px; font-size: 10px; margin-top: 6px; line-height: 1.9; }
.msf-pr-footer { margin-top: 6px; font-size: 8.5px; color: #aaa; border-top: 1px solid #eee; padding-top: 4px; display: flex; justify-content: space-between; }
body{margin:0;padding:0;font-family:"Noto Sans","Noto Sans Devanagari",Arial,sans-serif}
.msf-pr-page{padding:8px 0;page-break-after:always;font-size:12px;color:#111;line-height:1.55}
table{width:100%;border-collapse:collapse}
@media print{@page{size:A4;margin:12mm 14mm}}`;

function _msfLegacyBuild(app, idx) {
  var d = app.mahasabhaData || {};
  var safe = function(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  var dateStr = app.mahasabhaAppliedAt ? new Date(app.mahasabhaAppliedAt).toLocaleDateString('hi-IN',{day:'numeric',month:'long',year:'numeric'}) : '';
  var photoSrc = d.photo || app.photo || '';
  var sigSrc   = d.signatureDataUrl || '';

  function field(lbl, val, cls) {
    return '<td style="padding:3px 8px 3px 0;vertical-align:bottom;width:'+(cls||'50%')+'">'
      + '<span class="msf-pr-field-lbl">' + lbl + '</span>'
      + '<span class="msf-pr-field">' + safe(val) + '&nbsp;</span>'
      + '</td>';
  }
  function fullRow(lbl, val) {
    return '<tr><td colspan="2" style="padding:4px 0 2px;vertical-align:bottom">'
      + '<span class="msf-pr-field-lbl">' + lbl + '</span>'
      + '<span class="msf-pr-field" style="display:block">' + safe(val) + '&nbsp;</span>'
      + '</td></tr>';
  }

  return '<div class="msf-print-wrap">'

    // ── Header ──
    + '<div class="msf-pr-header">'
    + '<h2>अखिल भारतीय गहोई वैश्य महासभा (रजि.)</h2>'
    + '<p>केन्द्रीय कार्यालय : 1-बी गणेश बाजार, झांसी (उ.प्र.) &nbsp;|&nbsp; Phone: ____________</p>'
    + '<span class="msf-pr-badge">महासभा आजीवन सदस्यता आवेदन पत्र</span>'
    + '</div>'

    // ── Photo float ──
    + (photoSrc ? '<img class="msf-pr-photo" src="' + photoSrc + '" onerror="this.style.display=\'none\'">' : '<div style="float:right;margin:0 0 8px 14px;width:80px;height:90px;border:1px solid #ccc;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;color:#999;text-align:center;padding:4px">आवेदक का फोटो</div>')

    // ── Preamble ──
    + '<div style="font-size:11px;margin-bottom:10px">'
    + '<div>प्रति,&nbsp;&nbsp; अध्यक्ष / महामंत्री — अखिल भारतीय गहोई वैश्य महासभा</div>'
    + '<div style="margin-top:5px">महोदय,<br>मैं, महासभा का आजीवन सदस्य बनना चाहता/चाहती हूँ। नियमानुसार शुल्क रूपये '
    + '<strong>' + safe(d.shulk || '100') + '</strong> शब्दों में <strong>' + safe(d.shulkWords || 'एक सौ रुपये') + '</strong>'
    + ' नगद / रसीद / ड्राफ़्ट संख्या <strong>' + safe(d.draft || '—') + '</strong>'
    + ' दिनांक <strong>' + safe(d.draftDate || '—') + '</strong>'
    + ' द्वारा, श्री <strong>' + safe(d.dwara || '—') + '</strong> के हस्ते प्रेषित।'
    + ' कृपया मुझे आजीवन सदस्य बनाकर अनुग्रहीत करें।</div>'
    + '</div>'
    + '<div style="clear:both"></div>'

    // ── विवरण ──
    + '<div class="msf-pr-section-hdr">❋ &nbsp; विवरण &nbsp; ❋</div>'
    + '<table class="msf-pr-table">'
    + '<tr>' + field('स्थानीय पंचायत का नाम', d.panchayat) + field('क्षेत्रीय सभा', d.kshetra) + '</tr>'
    + '<tr>' + field('नाम (आंकना सहित)', (d.name || app.name) + (d.akna ? ' (' + d.akna + ')' : app.akna ? ' (' + app.akna + ')' : ''), '60%') + field('आंकना', d.akna || app.akna, '40%') + '</tr>'
    + '<tr>' + field('जन्म तिथि', d.dob, '35%') + field('शिक्षा', d.shiksha, '35%') + field('मांगलिक', d.manglik || '', '30%') + '</tr>'
    + fullRow('पिता / पति का नाम', d.father || app.father)
    + '<tr>' + field('व्यवसाय / पेशा', d.vyavsay || app.profession) + field('मूल निवासी', d.mool || app.native) + '</tr>'
    + fullRow('वर्तमान निवास का पता', d.address || app.address)
    + '<tr>' + field('ईमेल', d.email || app.email) + field('मोबाइल नं.', d.mobile || app.mobile) + '</tr>'
    + '</table>'

    // ── Declaration ──
    + '<div class="msf-pr-decl">मैं, महासभा के उद्देश्यों से सहमत हूँ तथा इसके नियमों का पालन करने का वचन देते हुये अपने पूर्ण सहयोग का आश्वासन देता हूँ / देती हूँ।</div>'

    // ── Signature row ──
    + '<div class="msf-pr-sig-row">'
    + '<div><span class="msf-pr-field-lbl">दिनांक</span><span class="msf-pr-field" style="min-width:140px;display:inline-block">' + safe(dateStr) + '</span></div>'
    + '<div style="text-align:center">'
    + (sigSrc ? '<img class="msf-pr-sig-img" src="' + sigSrc + '">' : '<div style="height:50px;width:160px;border-bottom:1px solid #999"></div>')
    + '<div style="font-size:9px;color:#555;margin-top:2px">हस्ताक्षर आवेदक</div>'
    + '</div></div>'

    // ── Payment info ──
    + (d.razorpayId ? '<div style="font-size:9px;background:#e8f5e9;border-radius:3px;padding:4px 8px;margin-bottom:6px;color:#2e7d52">✅ Online Payment: ₹' + safe(d.shulk||'100') + ' | Payment ID: ' + safe(d.razorpayId) + '</div>' : '')

    // ── Office use ──
    + '<div class="msf-pr-section-hdr">कार्यालय उपयोग के लिये</div>'
    + '<div class="msf-pr-office">'
    + 'रसीद / ड्राफ़्ट / क्रमांक ________________ दिनांक ________________ के अनुसार का आवेदन एवं रूपये ________________ प्राप्त हुये,<br>'
    + 'जिसका प्रविष्टि केश बुक के पेज क्र. ________________ पर दिनांक ________________ को कर दी गई है।<br>'
    + 'महासभा आवेदक को आजीवन सदस्य बनना स्वीकार करती है एवं सदस्यता क्रमांक ________________ दिनांक ________________ जारी करती है।'
    + '<div style="text-align:right;font-weight:700;color:#333;margin-top:6px">अध्यक्ष / महामंत्री महासभा</div>'
    + '</div>'

    // ── पावती ──
    + '<div class="msf-pr-section-hdr">✂&ensp; पावती &ensp;✂</div>'
    + '<div class="msf-pr-pavti">'
    + 'श्री / श्रीमती <strong>' + safe(d.name || app.name) + '</strong> &nbsp;आंकना: <strong>' + safe(d.akna || app.akna || '—') + '</strong> &nbsp;निवासी <strong>' + safe(d.vartaman || app.city || '—') + '</strong><br>'
    + 'क्षेत्र <strong>' + safe(d.kshetra || '—') + '</strong> से नियमानुसार शुल्क <strong>₹' + safe(d.shulk || '100') + '</strong> सहित आजीवन सदस्यता का आवेदन प्राप्त किया।'
    + '</div>'

    + '<div class="msf-pr-footer"><span>jaigahoi.in — Gahoi Portal | App. #' + (idx+1) + '</span><span>Applied: ' + safe(dateStr) + '</span></div>'

  + '</div>'; // .msf-print-wrap
}

function gpMsfFmtDob(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

// row = panchayat_memberships row, person = persons row (name, akna, mobile, ...)
function gpMsfBuildDoc(row, person, idx) {
  const f = row.form_data || {};
  const p = person || {};
  const app = {
    name: p.name || "", akna: p.akna || "", father: f.fatherOrHusband || p.father || "",
    profession: f.vyavsay || p.profession || "", native: f.mool || p.native || "",
    address: f.address || p.address || "", email: p.email || "", mobile: p.mobile || "", city: p.city || "",
    photo: f.photo || p.photo || "",
    mahasabhaAppliedAt: row.applied_at,
    mahasabhaData: {
      panchayat: f.panchayat || "", kshetra: f.kshetra || "", name: p.name || "", akna: p.akna || "",
      dob: gpMsfFmtDob(f.dob), shiksha: f.shiksha || "", manglik: f.manglik || "",
      father: f.fatherOrHusband || "", vyavsay: f.vyavsay || "", mool: f.mool || "",
      address: f.address || "", email: p.email || "", mobile: p.mobile || "",
      shulk: String(row.fee != null ? row.fee : 100), shulkWords: f.shulkWords || "",
      vartaman: f.vartaman || p.city || "", photo: f.photo || "", signatureDataUrl: f.signature || "",
      razorpayId: row.payment_id || "", draft: f.draft || "", draftDate: f.draftDate || "", dwara: f.dwara || ""
    }
  };
  return _msfLegacyBuild(app, idx);
}

// items = [{row, person}] — नई window में A4 print
function gpMsfPrint(items) {
  if (!items || !items.length) return false;
  const inner = items.map((it, i) => '<div class="msf-pr-page">' + gpMsfBuildDoc(it.row, it.person, i) + '</div>').join("");
  const w = window.open("", "_blank", "width=820,height=900");
  if (!w) return false;
  w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mahasabha Forms</title><style>' + GP_MSF_CSS + '</style></head><body>' + inner + '</body></html>');
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 600);
  return true;
}

// Payments CSV — legacy localStorage पर निर्भर था; अब सीधे DB rows से (UTF-8 BOM, Excel-safe)
function gpMsfDownloadPaymentsCSV(items) {
  const paid = (items || []).filter((it) => it.row.payment_id);
  if (!paid.length) return false;
  const rows = [["#", "Name", "Email", "Mobile", "GahoiId", "Payment ID", "Order ID", "Amount", "Applied At", "Status"]];
  paid.forEach((it, i) => {
    const p = it.person || {}, r = it.row;
    rows.push([i + 1, p.name || "", p.email || "", p.mobile || "", r.member_gahoi_id, r.payment_id || "", r.order_id || "", r.fee != null ? r.fee : "", r.applied_at || "", r.status]);
  });
  const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = "mahasabha_payments_" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
  return true;
}

// Hindi में शुल्क शब्दों में (legacy: "एक सौ रुपये")। छोटी राशियों के लिए पर्याप्त; बड़ी पर अंक + "रुपये"।
function gpMsfFeeWords(n) {
  const known = { 100: "एक सौ रुपये", 101: "एक सौ एक रुपये", 200: "दो सौ रुपये", 250: "दो सौ पचास रुपये", 300: "तीन सौ रुपये", 500: "पाँच सौ रुपये", 501: "पाँच सौ एक रुपये", 1000: "एक हज़ार रुपये", 1100: "ग्यारह सौ रुपये" };
  return known[Number(n)] || (String(n) + " रुपये");
}
