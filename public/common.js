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
