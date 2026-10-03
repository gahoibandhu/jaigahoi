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
  if (file.size > 5 * 1024 * 1024) {
    return { success: false, message: "Image 5MB से बड़ी नहीं होनी चाहिए।" };
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
    // supabase-js की functions.invoke() error होने पर भी अक्सर response body context.error में होती है
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
