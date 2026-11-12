// ============================================================================
// गहोई पोर्टल — common.js
// हर .html page यही file include करेगा (भाग 2 का MPA pattern — shared JS,
// कोई JS-router नहीं, असली <a href> navigation)
// ============================================================================

// SUPABASE_URL/ANON_KEY अब public/config.js से आते हैं (हर page में config.js,
// common.js से पहले load होनी चाहिए — देखें कोई भी .html का <head>)। बाक़ी हर
// configurable value (Cloudinary, Razorpay, branding वगैरह) अब यहाँ नहीं,
// बल्कि app_settings table से — नीचे gpGetSetting()/gpGetSettings() देखें।
const SUPABASE_URL = window.GP_CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.GP_CONFIG.SUPABASE_ANON_KEY;

// supabase-js CDN से लोड होगा (हर page के <head> में script-tag चाहिए, देखें login.html)
const gpSupabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ----------------------------------------------------------------------------
// Referral-link capture — referrals.html से मिला लिंक जब कोई खोलता है
// (?ref=GAHOIID), वो register Edge Function referrerGahoiId ज़रूर स्वीकार करता
// है (देखें register/index.ts), पर उसे भेजने के लिए किसी page में यह पढ़ा ही
// नहीं जा रहा था — असली gap, यहीं fix कर रहे हैं। localStorage में रखते हैं
// (sessionStorage नहीं) क्योंकि Google OAuth redirect बीच में आता है, जो query
// param उड़ा सकता है — "first-touch wins", एक बार set हो गया तो दोबारा overwrite
// नहीं करते जब तक इस्तेमाल (और साफ़) ना हो जाए (देखें complete-profile.html)।
(function captureReferral() {
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = (params.get("ref") || "").trim().toUpperCase();
    if (ref && !localStorage.getItem("gp_referrer_gahoi_id")) {
      localStorage.setItem("gp_referrer_gahoi_id", ref);
    }
  } catch (e) { /* localStorage ना मिले (private browsing वग़ैरह) तो चुपचाप skip */ }
})();

// ----------------------------------------------------------------------------
// Public settings (settings table, doc_id='publicConfig') — Cloudinary
// cloud-name, Razorpay Key ID, portal branding वगैरह। RLS सीधे पढ़ने देती है
// (कोई Edge Function ज़रूरी नहीं — publishable values हैं, गुप्त नहीं)।
// एक बार load होकर पूरे page-load भर के लिए cache रहता है।
// ----------------------------------------------------------------------------
let _gpPublicConfigCache = null;
async function gpGetPublicConfig() {
  if (_gpPublicConfigCache) return _gpPublicConfigCache;
  const { data, error } = await gpSupabase.from("settings").select("data").eq("doc_id", "publicConfig").maybeSingle();
  _gpPublicConfigCache = (!error && data && data.data) ? data.data : {};
  return _gpPublicConfigCache;
}
async function gpGetPublicSetting(key, fallback) {
  const config = await gpGetPublicConfig();
  return (key in config && config[key] !== "") ? config[key] : fallback;
}

// ----------------------------------------------------------------------------
// किसी भी non-secrets doc से setting पढ़ने का generic helper (migration 0014 के
// बाद 'secrets' के अलावा हर doc RLS से publicly readable है — appConfig की
// mahasabhaFee वग़ैरह पढ़ने के लिए, बिना नया publicConfig-जैसा cache दोहराए)।
// doc-wise cache — हर doc सिर्फ़ पहली बार page-load पर fetch होगा।
// ----------------------------------------------------------------------------
const _gpSettingsDocCache = {};
async function gpGetSettingsDoc(docId) {
  if (_gpSettingsDocCache[docId]) return _gpSettingsDocCache[docId];
  const { data, error } = await gpSupabase.from("settings").select("data").eq("doc_id", docId).maybeSingle();
  const result = (!error && data && data.data) ? data.data : {};
  _gpSettingsDocCache[docId] = result;
  return result;
}
async function gpGetSetting(docId, key, fallback) {
  const doc = await gpGetSettingsDoc(docId);
  return (key in doc && doc[key] !== "" && doc[key] !== null) ? doc[key] : fallback;
}

// ----------------------------------------------------------------------------
// Auth-guard — जिन pages पर login ज़रूरी है, वहाँ ये सबसे ऊपर call करें
// ----------------------------------------------------------------------------
async function gpRequireLogin(redirectTo = "login.html") {
  const { data: { session } } = await gpSupabase.auth.getSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session;
}

// ----------------------------------------------------------------------------
// मौजूदा user का persons-row लाना (अपनी row हमेशा readable है, RLS policy से)
// ----------------------------------------------------------------------------
async function gpGetMyProfile() {
  const { data: { session } } = await gpSupabase.auth.getSession();
  if (!session) return null;
  const { data, error } = await gpSupabase
    .from("persons")
    .select("*")
    .eq("auth_uid", session.user.id)
    .maybeSingle();
  if (error) {
    console.error("gpGetMyProfile error:", error);
    return null;
  }
  return data;
}

// ----------------------------------------------------------------------------
// Edge Function बुलाने का साझा helper — हमेशा current session का JWT भेजेगा
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// Cloudinary — unsigned upload helper (कोई असली "Cloudinary setup" फ़िलहाल कहीं
// भी functional नहीं था — profile.html/complete-profile.html में photo field ही
// नहीं था, gallery.html सिर्फ़ पहले से मौजूद URL paste करने देता था। यह असली gap
// था, यहीं fix कर रहे हैं।
//
// Unsigned upload को सिर्फ़ cloudName + uploadPreset चाहिए (दोनों publicConfig
// में, migration 0014 के बाद publicly readable) — apiKey/apiSecret की ज़रूरत ही
// नहीं होती unsigned upload के लिए, वो सिर्फ़ delete/signed operations के लिए हैं
// (जो client से कभी नहीं करने चाहिए — इसलिए यहाँ छुए भी नहीं)।
// ----------------------------------------------------------------------------
async function gpUploadToCloudinary(file, folder = "gahoi-portal") {
  const cloudName = await gpGetSetting("publicConfig", "cloudinaryCloudName", "");
  const uploadPreset = await gpGetSetting("publicConfig", "cloudinaryUploadPreset", "");
  if (!cloudName || !uploadPreset) {
    return { success: false, message: "Cloudinary अभी configure नहीं है — Admin को Settings में Cloud Name/Upload Preset भरने दें।" };
  }
  if (!file || !file.type || !file.type.startsWith("image/")) {
    return { success: false, message: "कृपया एक image file चुनें।" };
  }
  if (file.size > 15 * 1024 * 1024) {
    return { success: false, message: "Image 15MB से बड़ी नहीं होनी चाहिए।" };
  }
  file = await gpCompressImage(file); // मोबाइल की बड़ी फोटो छोटी करके upload (legacy compress जैसा)
  if (file.size > 5 * 1024 * 1024) {
    return { success: false, message: "Image compress के बाद भी 5MB से बड़ी है — कोई छोटी फोटो चुनें।" };
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", uploadPreset);
  formData.append("folder", folder);

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (!res.ok || !data.secure_url) {
      return { success: false, message: (data.error && data.error.message) || "Upload असफल रहा।" };
    }
    return { success: true, url: data.secure_url };
  } catch (e) {
    return { success: false, message: "Upload नहीं हो सका: " + e.message };
  }
}

async function gpCallFunction(functionName, payload) {
  const { data: { session } } = await gpSupabase.auth.getSession();
  const { data, error } = await gpSupabase.functions.invoke(functionName, {
    body: payload,
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : {},
  });
  if (error) {
    // Function ने 4xx/5xx के साथ अपना JSON (success:false + Hindi message) भेजा हो तो वही लौटाओ —
    // वरना user को सिर्फ़ "Edge Function returned a non-2xx status code" दिखता और असली संदेश खो जाता।
    try {
      if (error.context && typeof error.context.json === "function") {
        const body = await error.context.json();
        if (body && typeof body === "object" && ("message" in body || "success" in body)) return body;
      }
    } catch (e) { /* body JSON नहीं था — नीचे generic संदेश */ }
    return { success: false, message: error.message || "Request failed." };
  }
  return data;
}

// ----------------------------------------------------------------------------
// Simple alert-box helper — हर page पर एक जैसा दिखे
// ----------------------------------------------------------------------------
function gpShowAlert(elId, message, type = "error") {
  const el = document.getElementById(elId);
  if (!el) return;
  el.className = `gp-alert gp-alert-${type}`;
  el.textContent = message;
  el.style.display = "block";
}

function gpHideAlert(elId) {
  const el = document.getElementById(elId);
  if (el) el.style.display = "none";
}

// ----------------------------------------------------------------------------
// Feature flags — GR की standing requirement (2026-09-25): admin हर feature/
// page/payment option को on/off कर सके, और बंद होने पर member को साफ़ popup
// दिखे, ना कि कोई silent broken page। featureFlags settings doc migration
// 0015 में seed हुआ है और (secrets को छोड़कर बाक़ी हर doc की तरह) migration
// 0014 के बाद publicly readable है — इसलिए यहाँ किसी Edge Function की ज़रूरत
// नहीं, gpGetSetting("featureFlags", ...) से सीधे पढ़ लेते हैं।
//
// इस्तेमाल: किसी page के auth-gate के ठीक बाद —
//   if (!(await gpGuardFeature("mahasabhaEnabled", "Mahasabha Membership"))) return;
// return false मिलने का मतलब है page पहले ही redirect कर चुका, आगे कुछ मत करो।
// ----------------------------------------------------------------------------
async function gpIsFeatureEnabled(flagKey, fallback = true) {
  return await gpGetSetting("featureFlags", flagKey, fallback);
}

async function gpGuardFeature(flagKey, featureLabelHindi) {
  const enabled = await gpIsFeatureEnabled(flagKey, true);
  if (enabled) return true;
  const customMsg = await gpGetSetting("featureFlags", "portalMaintenanceMessage", "");
  window.alert(
    customMsg && customMsg.trim()
      ? customMsg
      : `⚠️ "${featureLabelHindi}" फ़िलहाल Admin द्वारा बंद किया गया है। कृपया बाद में कोशिश करें।`
  );
  window.location.href = "home.html";
  return false;
}


// ============================================================================
// Display settings — Theme रंग (6) + Classic ⇄ Royal mode
// पुराने index.html के THEMES / applyTheme / initTheme और royal-toggle.js से ported।
// Preference इस device के localStorage में रहती है (पुराने portal जैसा):
//   gp_theme_v1   = maroon | saffron | emerald | charcoal | rose | navy
//   gp-theme-mode = royal | classic
// सिर्फ़ CSS variables बदलते हैं, इसलिए हर page पर अपने-आप लागू होता है।
// ============================================================================
const GP_THEMES = {
  maroon:   { name: "🏛 Royal Maroon",   desc: "Traditional Indian wedding",       vars: { "--primary": "#7a1f3d", "--primary2": "#a01840", "--primary-dark": "#5a0e26", "--accent": "#d4af37", "--accent2": "#f0b429" } },
  saffron:  { name: "🌼 Saffron Indigo", desc: "Indian flag inspired (trending)",  vars: { "--primary": "#3730a3", "--primary2": "#4f46e5", "--primary-dark": "#1e1b4b", "--accent": "#f57c00", "--accent2": "#fb923c" } },
  emerald:  { name: "💎 Emerald Gold",   desc: "Luxury wedding aesthetic",         vars: { "--primary": "#064e3b", "--primary2": "#047857", "--primary-dark": "#022c22", "--accent": "#d4af37", "--accent2": "#f0b429" } },
  charcoal: { name: "⚫ Charcoal Gold",  desc: "Modern professional",              vars: { "--primary": "#111827", "--primary2": "#1f2937", "--primary-dark": "#030712", "--accent": "#fbbf24", "--accent2": "#f59e0b" } },
  rose:     { name: "🌹 Rose Gold",      desc: "Elegant modern",                   vars: { "--primary": "#9f1239", "--primary2": "#be185d", "--primary-dark": "#6b0826", "--accent": "#f59e0b", "--accent2": "#fbbf24" } },
  navy:     { name: "🔵 Navy Classic",   desc: "Original blue (safe)",             vars: { "--primary": "#1a3a5c", "--primary2": "#264f82", "--primary-dark": "#0d2038", "--accent": "#e8a020", "--accent2": "#f0b429" } }
};
const GP_THEME_KEY = "gp_theme_v1";
const GP_MODE_KEY = "gp-theme-mode";

function gpGetSavedTheme() { try { return localStorage.getItem(GP_THEME_KEY) || ""; } catch (e) { return ""; } }
function gpGetSavedMode() { try { return localStorage.getItem(GP_MODE_KEY) || "royal"; } catch (e) { return "royal"; } }

function gpApplyTheme(key, persist) {
  const theme = GP_THEMES[key];
  if (!theme) return false;
  const root = document.documentElement;
  Object.keys(theme.vars).forEach((v) => root.style.setProperty(v, theme.vars[v]));
  if (persist !== false) { try { localStorage.setItem(GP_THEME_KEY, key); } catch (e) {} }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme.vars["--primary"]);
  return true;
}

function gpApplyMode(mode, persist) {
  const m = mode === "classic" ? "classic" : "royal";
  document.documentElement.setAttribute("data-theme-mode", m);
  gpToggleClassicCss(m === "classic");
  if (persist !== false) { try { localStorage.setItem(GP_MODE_KEY, m); } catch (e) {} }
  return m;
}

function gpResetDisplay() {
  try { localStorage.removeItem(GP_THEME_KEY); localStorage.removeItem(GP_MODE_KEY); } catch (e) {}
  const root = document.documentElement;
  Object.keys(GP_THEMES.maroon.vars).forEach((v) => root.style.removeProperty(v));
  root.setAttribute("data-theme-mode", "royal");
}

// हर page load पर saved पसंद लागू करो
(function gpInitDisplay() {
  gpApplyMode(gpGetSavedMode(), false);
  const saved = gpGetSavedTheme();
  if (saved) gpApplyTheme(saved, false);
})();


// ============================================================================
// Upload helpers — सब modules (business/offers/events/gallery/magazine/space/matrimony) के लिए
// ============================================================================
async function gpCompressImage(file, maxDim = 1600, quality = 0.82) {
  try {
    if (!file || !file.type || !file.type.startsWith("image/") || /gif|svg/.test(file.type)) return file;
    if (file.size < 350 * 1024) return file; // पहले से छोटी फोटो जस की तस
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (e) { return file; }
}

// Image या PDF — Cloudinary "auto" endpoint (Magazine PDF के लिए)
async function gpUploadFileToCloudinary(file, folder = "gahoi-portal", opts = {}) {
  const isPdf = file && file.type === "application/pdf";
  if (!isPdf) return gpUploadToCloudinary(file, folder);
  if (!opts.allowPdf) return { success: false, message: "यहाँ सिर्फ़ image चुनें।" };
  const cloudName = await gpGetSetting("publicConfig", "cloudinaryCloudName", "");
  const uploadPreset = await gpGetSetting("publicConfig", "cloudinaryUploadPreset", "");
  if (!cloudName || !uploadPreset) return { success: false, message: "Cloudinary अभी configure नहीं है — Admin को Settings में Cloud Name/Upload Preset भरने दें।" };
  if (file.size > 15 * 1024 * 1024) return { success: false, message: "PDF 15MB से बड़ी नहीं होनी चाहिए।" };
  const fd = new FormData();
  fd.append("file", file); fd.append("upload_preset", uploadPreset); fd.append("folder", folder);
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data.secure_url) return { success: false, message: (data.error && data.error.message) || "Upload असफल रहा।" };
    return { success: true, url: data.secure_url };
  } catch (e) { return { success: false, message: "Upload नहीं हो सका: " + e.message }; }
}

// file input -> upload -> URL input भर दे। opts: { file, url, status, preview, folder, pdf }
function gpWireUpload(opts) {
  const fileEl = document.getElementById(opts.file), urlEl = document.getElementById(opts.url);
  const stEl = opts.status ? document.getElementById(opts.status) : null;
  const pvEl = opts.preview ? document.getElementById(opts.preview) : null;
  if (!fileEl || !urlEl) return;
  const show = (u) => { if (pvEl) { if (u) { pvEl.src = u; pvEl.style.display = "block"; } else pvEl.style.display = "none"; } };
  fileEl.addEventListener("change", async () => {
    const f = fileEl.files[0]; if (!f) return;
    if (stEl) stEl.textContent = "⏳ Upload हो रहा है...";
    const r = await gpUploadFileToCloudinary(f, opts.folder || "gahoi-portal", { allowPdf: !!opts.pdf });
    if (!r.success) { if (stEl) stEl.textContent = "❌ " + r.message; return; }
    urlEl.value = r.url; show(r.url);
    if (stEl) stEl.textContent = "✅ Upload हो गया।";
  });
  urlEl.addEventListener("input", () => show(urlEl.value.trim()));
}

// CSV line parser (quotes समेत) — legacy parseCSVLine जैसा
function gpParseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
}

// ============================================================================
// Legacy look — purane jaigahoi.in jaisa Header + Nav + Ticker + Mobile tabs
// (markup/class-naam legacy index.html se; CSS common.css me). Har page par apne-aap lagta hai;
// kisi page par nahi chahiye to <body data-no-shell> likhein.
// ============================================================================
function gpToggleClassicCss(on) {
  const id = "gp-classic-css", cur = document.getElementById(id);
  if (on && !cur) { const l = document.createElement("link"); l.id = id; l.rel = "stylesheet"; l.href = "shell-classic.css"; document.head.appendChild(l); }
  if (!on && cur) cur.remove();
}
(function () {
  const HEADER_HTML = "<header class=\"site-header\"><div class=\"site-header-inner\"><img class=\"header-logo\" src=\"https://res.cloudinary.com/dtcrife6i/image/upload/v1774665185/New_-_Logo_aktdtf.png\" alt=\"गहोई पोर्टल\" fetchpriority=\"high\"><div class=\"header-center\"><div class=\"header-title\">❋ गहोई पोर्टल ❋<br><span style=\"font-size:.62em;font-weight:500;opacity:.88;letter-spacing:.2px\">गहोई वैश्य समाज का अपना पोर्टल</span></div><div class=\"header-sub\">All India Gahoi Vaishya Community Portal</div><div class=\"header-sub\" style=\"display:none\" id=\"header-sub-short\">Gahoi Vaishya Samaj</div><div class=\"header-marquee\"><span>🙏 समाज की सेवा में समर्पित &nbsp;|&nbsp; 25,000+ परिवार &nbsp;|&nbsp; Member Directory · Matrimony · Business · Jobs &nbsp;|&nbsp; गहोई पोर्टल परिवार में आपका स्वागत है 🌸</span></div></div><img class=\"header-poet\" src=\"https://res.cloudinary.com/dtcrife6i/image/upload/v1773380258/Mathili_opa2ns.jpg\" alt=\"Maithili Sharan Gupt\" fetchpriority=\"high\"></div></header>";
  const TICKER_HTML = "<div class=\"ticker-wrap\" id=\"ticker-wrap\"><div class=\"ticker-track\"><span class=\"ticker-segment\"><span class=\"ticker-text\">🙏 Welcome to Gahoi Portal – गहोई वैश्य समाज &nbsp;|  📧 <span class=\"ticker-email-slot ticker-wa\"></span> &nbsp;|  Member Directory · Matrimony · Business · Jobs · Community Space &nbsp;|  🌟 आपका हार्दिक स्वागत है</span></span> <span class=\"ticker-segment\"><span class=\"ticker-text\">🙏 Welcome to Gahoi Portal – गहोई वैश्य समाज &nbsp;|  📧 <span class=\"ticker-email-slot ticker-wa\"></span> &nbsp;|  Member Directory · Matrimony · Business · Jobs · Community Space &nbsp;|  🌟 आपका हार्दिक स्वागत है</span></span></div></div>";
  const MAIN = [["home.html","🏠 Home"],["directory.html","🔍 Members"],["professionals.html","🎓 Samaj"],["events.html","🎉 Events"],["matrimony.html","💑 Matrimony"],["jobs.html","💼 Jobs"],["business.html","🏢 Business"],["offers.html","🏷️ Offers"],["space.html","💬 Space"],["magazines.html","📖 Magazine"],["gallery.html","🖼️ Gallery"],["dharmshala.html","🛕 Dharmshala"],["daan-seva.html","🙏 Daan Seva"]];
  const ADMIN_ALL = [["admin-pending.html","⏳ Pending Approvals"],["admin-members.html","👥 Members"],["admin-mahasabha.html","📋 Mahasabha Applications"],["admin-professions.html","🎓 Professional Tags"],["admin-aknas.html","🏷 अकना Review"],["admin-broadcast.html","📣 Broadcast"],["admin-ledger.html","📒 Ledger"],["admin-audit-log.html","🧾 Audit Log"],["admin-auth.html","🔐 Login Settings"],["admin-features.html","🧩 Features"],["admin-privacy.html","🔒 Privacy / DPDP"],["admin-settings.html","⚙️ Settings"]];
  const ADMIN_APPROVER = ["admin-pending.html","admin-members.html","admin-mahasabha.html","admin-professions.html","admin-aknas.html","admin-broadcast.html"];
  const TABS = [["home.html","🏠","Home"],["directory.html","🔍","Search"],["matrimony.html","💑","Matrimony"],["messages.html","💬","Messages"],["profile.html","👤","You"]];
  const SKIP = ["auth-callback.html","index.html","matrimony-biodata.html"];
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const file = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  function initials(me) { const n = String((me && me.name) || "?").trim().split(/\s+/); return ((n[0] || "?")[0] + (n[1] ? n[1][0] : "")).toUpperCase(); }

  function navHtml(me) {
    const link = (h, l, extra) => `<a class="nav-btn${h === file ? " active" : ""}${extra || ""}" href="${h}">${l}</a>`;
    let menu = "";
    if (!me) {
      menu = link("login.html", "🔑 Login / Register", " nav-btn-auth");
    } else if (me.status !== "Approved" && me.role !== "Admin") {
      menu = link("profile.html", `<span class="nav-profile-avatar">${esc(initials(me))}</span> <span class="nav-profile-label">Profile</span>`, " nav-btn-profile") + `<a class="nav-btn nlg" href="#" data-logout>↩ Logout</a>`;
    } else {
      menu = MAIN.map(([h, l]) => link(h, l)).join("");
      if (me.role === "Admin" || me.role === "Approver") {
        const items = me.role === "Admin" ? ADMIN_ALL : ADMIN_ALL.filter((x) => ADMIN_APPROVER.includes(x[0]));
        const adminActive = items.some((x) => x[0] === file) ? " active" : "";
        menu += `<div class="nav-admin"><a class="nav-btn${adminActive}" href="#" data-admin-toggle>⚙ Admin ▾</a><div class="nav-admin-menu">${items.map(([h, l]) => `<a href="${h}">${l}</a>`).join("")}</div></div>`;
      }
      menu += link("profile.html", `<span class="nav-profile-avatar">${esc(initials(me))}</span> <span class="nav-profile-label">Profile</span>`, " nav-btn-profile");
      menu += link("messages.html", "✉️ Messages", " nav-btn-messages");
      menu += link("mahasabha.html", "📋 महासभा");
      menu += `<a class="nav-btn nlg" href="#" data-logout>↩ Logout</a>`;
    }
    return `<nav><a class="nav-logo" href="${me ? "home.html" : "login.html"}" style="text-decoration:none">🏘 गहोई पोर्टल</a>` +
      `<a class="nav-search-btn" href="directory.html" title="Members खोजें" aria-label="Search">🔍</a>` +
      `<button class="hamburger" id="hamburger-btn" aria-label="Menu"><span></span><span></span><span></span></button>` +
      `<a class="nav-theme-btn" href="display-settings.html" title="Theme / Display" aria-label="Display Settings">🎨</a>` +
      `<div class="nav-menu" id="nav-menu">${menu}</div></nav>`;
  }
  function tabsHtml() {
    return `<div id="mobile-tabs"><div class="mt-row">` + TABS.map(([h, i, l]) => `<a class="mt-tab${h === file ? " active" : ""}" href="${h}" style="text-decoration:none"><span class="mt-icon">${i}</span><span>${l}</span></a>`).join("") + `</div></div>`;
  }

  function mount() {
    if (document.body.hasAttribute("data-no-shell") || SKIP.includes(file) || document.getElementById("gp-shell-top")) return;
    document.body.classList.add("gp-shell");
    const top = document.createElement("div"); top.id = "gp-shell-top";
    top.innerHTML = HEADER_HTML + navHtml(null);
    document.body.insertBefore(top, document.body.firstChild);
    const tk = document.createElement("div"); tk.innerHTML = TICKER_HTML; while (tk.firstChild) document.body.appendChild(tk.firstChild);
    document.querySelectorAll(".ticker-email-slot").forEach((e) => { e.innerHTML = '<a href="mailto:gahoi.portal@gmail.com" style="color:inherit;font-weight:700">gahoi.portal@gmail.com</a>'; });
    const mt = document.createElement("div"); mt.innerHTML = tabsHtml(); document.body.appendChild(mt.firstChild);
    wire(); fitHero(); window.addEventListener("resize", fitHero);
    (async () => {                       // login/status jaan kar nav asli banao
      let me = null;
      try { const { data: { session } } = await gpSupabase.auth.getSession(); if (session) me = await gpGetMyProfile(); } catch (e) {}
      const nv = top.querySelector("nav"); const fresh = document.createElement("div"); fresh.innerHTML = navHtml(me);
      nv.replaceWith(fresh.firstChild); wire();
      if (!me || (me.status !== "Approved" && me.role !== "Admin")) document.getElementById("mobile-tabs").style.display = "none";
      if (file === "home.html") modePill();
    })();
  }
  function wire() {
    const hb = document.getElementById("hamburger-btn"), menu = document.getElementById("nav-menu");
    if (hb && menu) hb.onclick = () => { hb.classList.toggle("open"); menu.classList.toggle("open"); };
    document.querySelectorAll("[data-admin-toggle]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); a.parentNode.classList.toggle("open"); }; });
    document.addEventListener("click", (e) => { document.querySelectorAll(".nav-admin.open").forEach((d) => { if (!d.contains(e.target)) d.classList.remove("open"); }); });
    document.querySelectorAll("[data-logout]").forEach((a) => { a.onclick = async (e) => { e.preventDefault(); try { await gpSupabase.auth.signOut(); } catch (x) {} window.location.href = "login.html"; }; });
  }
  // page ka title-bar (.gp-header) = legacy hero banner, neeche ke content jitni chaudai par
  function fitHero() {
    const h = document.querySelector(".gp-header"); if (!h) return;
    const t = h.querySelector("h1");
    if (t && t.textContent.trim() === "गहोई पोर्टल") { h.classList.add("gp-hide"); return; }     // login/register: upar ka header hi kaafi
    let n = h.nextElementSibling; while (n && /^(SCRIPT|STYLE|LINK)$/.test(n.tagName)) n = n.nextElementSibling;
    if (n) { const w = Math.round(n.getBoundingClientRect().width); if (w > 300) h.style.setProperty("--hero-w", Math.min(w, 1100) + "px"); }
  }
  function modePill() {
    if (document.getElementById("gp-mode-pill")) return;
    const b = document.createElement("button"); b.id = "gp-mode-pill"; b.type = "button";
    const classic = gpGetSavedMode() === "classic";
    b.innerHTML = `<span class="ic">✨</span><span class="ic">🏛</span><span>${classic ? "Switch to Royal" : "Switch to Classic"}</span>`;
    b.onclick = () => { gpApplyMode(gpGetSavedMode() === "classic" ? "royal" : "classic"); b.remove(); };
    document.body.appendChild(b);
    setTimeout(() => { b.style.opacity = "0"; b.style.pointerEvents = "none"; }, 7000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
