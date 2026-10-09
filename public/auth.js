// ============================================================================
// auth.js — login / signup / password pages ka shared code
// (config.js + common.js ke BAAD load karo; gpSupabase, SUPABASE_URL, SUPABASE_ANON_KEY chahiye)
//
// Admin ke toggles settings.publicConfig mein rehte hain (admin-auth.html se badalte hain):
//   authGoogleEnabled, authEmailOtpEnabled, authPasswordSignupEnabled,
//   authPasswordLoginEnabled, authMobileOtpEnabled (default OFF)
// Mobile OTP tabhi dikhta hai jab Admin ne ON kiya HO **aur** Supabase mein Phone provider
// sach mein enabled ho (/auth/v1/settings se asli status padhte hain) — yaani "configure nahi
// hai" wala option login page par kabhi nahi dikhega.
// ============================================================================
function gpAsBool(v, fallback) {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return fallback;
}

async function gpFetchProviderStatus() {
  try {
    const res = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/settings", { headers: { apikey: SUPABASE_ANON_KEY } });
    if (!res.ok) return null;
    const j = await res.json();
    return { google: !!(j.external && j.external.google), phone: !!(j.external && j.external.phone), email: !(j.external && j.external.email === false), raw: j };
  } catch (e) { return null; }
}

async function gpAuthConfig(opts) {
  const fresh = opts && opts.fresh;
  let cfg = {};
  if (fresh) {
    const { data } = await gpSupabase.from("settings").select("data").eq("doc_id", "publicConfig").maybeSingle();
    cfg = (data && data.data) || {};
  } else {
    cfg = await gpGetPublicConfig();
  }
  const status = await gpFetchProviderStatus();
  const adminMobileOn = gpAsBool(cfg.authMobileOtpEnabled, false);
  return {
    googleEnabled: gpAsBool(cfg.authGoogleEnabled, true),
    emailOtpEnabled: gpAsBool(cfg.authEmailOtpEnabled, true),
    passwordSignupEnabled: gpAsBool(cfg.authPasswordSignupEnabled, true),
    passwordLoginEnabled: gpAsBool(cfg.authPasswordLoginEnabled, true),
    mobileOtpAdminOn: adminMobileOn,
    phoneProviderOn: status ? status.phone : false,       // status na mile to safe side: false
    mobileOtpEnabled: adminMobileOn && !!(status && status.phone),
    providerStatus: status
  };
}

// Config load na ho paye to bhi page khali na rahe — "default" tareeqe dikhao (Mobile OTP safe side par band)
function gpAuthDefaults() {
  return { googleEnabled: true, emailOtpEnabled: true, passwordSignupEnabled: true, passwordLoginEnabled: true,
           mobileOtpAdminOn: false, phoneProviderOn: false, mobileOtpEnabled: false, providerStatus: null };
}

// ?debug=1 lagane par page ke neeche config + error dikhta hai (console kholne ki zaroorat nahi)
function gpAuthDebug(cfg, err) {
  if (!/[?&]debug=1/.test(window.location.search)) return;
  const pre = document.createElement("pre"); pre.id = "gpAuthDebug";
  pre.style.cssText = "max-width:440px;margin:16px auto;padding:10px;background:#1e1612;color:#f5ecd4;font-size:12px;border-radius:10px;white-space:pre-wrap;overflow:auto";
  const st = cfg && cfg.providerStatus;
  pre.textContent = "AUTH DEBUG\n" + JSON.stringify({
    page: window.location.href, supabaseUrl: typeof SUPABASE_URL !== "undefined" ? SUPABASE_URL : "(SUPABASE_URL undefined)",
    config: cfg && { google: cfg.googleEnabled, emailOtp: cfg.emailOtpEnabled, pwLogin: cfg.passwordLoginEnabled, pwSignup: cfg.passwordSignupEnabled, mobileAdmin: cfg.mobileOtpAdminOn, mobileEffective: cfg.mobileOtpEnabled },
    supabaseProviders: st ? { google: st.google, phone: st.phone, email: st.email } : "(status fetch failed)",
    initError: err ? String(err.message || err) : null }, null, 2);
  document.body.appendChild(pre);
}

// Google sign-in/up — login aur register dono isi ko bulate hain
async function gpAuthGoogle(alertId) {
  gpHideAlert(alertId);
  if (window.location.protocol === "file:") {
    gpShowAlert(alertId, "Google login file:// से नहीं चलता — site को https://jaigahoi.in से, या local server (जैसे: npx serve public) से खोलकर आज़माएँ।", "error");
    return;
  }
  const { error } = await gpSupabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin + "/auth-callback.html" } });
  if (error) gpShowAlert(alertId, gpFriendlyAuthError(error), "error");
}

// Password policy: kam se kam 8 akshar, ek letter aur ek ank
function gpPasswordProblem(pw) {
  if (!pw || pw.length < 8) return "Password कम से कम 8 अक्षर का होना चाहिए।";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Password में कम से कम एक अक्षर (A-Z) और एक अंक (0-9) होना चाहिए।";
  if (/^(12345678|password|qwertyui|11111111)/i.test(pw)) return "यह password बहुत आसान है — कुछ और चुनें।";
  return "";
}

function gpFriendlyAuthError(err) {
  const m = String((err && (err.message || err.error_description)) || err || "").toLowerCase();
  if (/rate limit|too many|over_.*_rate|seconds/.test(m)) return "बहुत जल्दी-जल्दी कोशिश हुई — एक मिनट रुककर फिर प्रयास करें।";
  if (/expired|invalid|token/.test(m)) return "Code ग़लत है या expire हो गया — नया code मँगवाएँ।";
  if (/already registered|already been registered/.test(m)) return "यह email पहले से registered है — Login करें।";
  if (/unsupported provider|provider is not enabled/.test(m)) return "Google login Supabase में चालू नहीं है — Dashboard → Authentication → Providers → Google ON करें (Client ID/Secret के साथ)।";
  if (/phone.*(provider|not enabled|unsupported)|sms/.test(m)) return "Mobile OTP अभी चालू नहीं है — Email से जारी रखें।";
  if (/invalid login|invalid credentials/.test(m)) return "Email या Password ग़लत है।";
  if (/email not confirmed/.test(m)) return "Email अभी verify नहीं हुई — अपना inbox देखें।";
  return "कुछ गड़बड़ हुई — फिर कोशिश करें।";
}

// Resend button par countdown
function gpStartCooldown(btn, seconds, idleLabel) {
  let left = seconds; btn.disabled = true;
  const tick = () => { if (left <= 0) { btn.disabled = false; btn.textContent = idleLabel; return; } btn.textContent = `${idleLabel} (${left}s)`; left--; setTimeout(tick, 1000); };
  tick();
}

// "आँख" वाला show/hide password
function gpWirePasswordToggle(inputId, btnId) {
  const i = document.getElementById(inputId), b = document.getElementById(btnId);
  if (!i || !b) return;
  b.addEventListener("click", () => { const show = i.type === "password"; i.type = show ? "text" : "password"; b.textContent = show ? "🙈" : "👁"; });
}

// Login ke baad sahi jagah bhejo
async function gpRouteAfterLogin() {
  const profile = await gpGetMyProfile();
  if (!profile) { window.location.href = "complete-profile.html"; return; }
  if (profile.status === "Pending") { window.location.href = "pending-approval.html"; return; }
  window.location.href = "home.html";
}

const GP_AUTH_CSS = `
.au-tabs{display:flex;gap:6px;margin:0 0 14px;flex-wrap:wrap}
.au-tabs button{flex:1;min-width:90px;padding:8px 10px;border:1.5px solid var(--border);background:var(--paper);border-radius:10px;font-weight:700;font-size:.82rem;cursor:pointer;font-family:inherit;color:var(--text)}
.au-tabs button.active{background:var(--primary);color:#fff;border-color:var(--primary)}
.au-pw{position:relative}.au-pw input{padding-right:42px}
.au-eye{position:absolute;right:6px;top:30px;background:none;border:none;font-size:1.05rem;cursor:pointer;padding:4px 8px}
.au-code{letter-spacing:.5em;font-size:1.4rem;text-align:center;font-weight:700}
.au-link{background:none;border:none;color:var(--primary);font-weight:700;cursor:pointer;font-family:inherit;font-size:.86rem;padding:0}
.au-step{display:none}.au-step.on{display:block}
.au-note{font-size:.78rem;color:var(--gp-text-muted);margin-top:6px}
`;
(function () { const s = document.createElement("style"); s.textContent = GP_AUTH_CSS; document.head.appendChild(s); })();
