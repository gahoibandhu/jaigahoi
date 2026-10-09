// ============================================================================
// Edge Function: find-user-id — "User ID (Email) भूल गए" (legacy doFindUserId का port)
// SELF-CONTAINED (Dashboard "Via Editor" के लिए, कोई relative import नहीं) — register.ts जैसा ही।
//
// Deploy: Dashboard -> Edge Functions -> New -> नाम `find-user-id` -> यह code paste।
//   "Verify JWT" ON रह सकता है: logged-out पेज से भी supabase-js anon key (एक valid JWT) भेजता है।
//   (Function के अंदर rate-limit है, इसलिए anonymous call सुरक्षित है।)
//
// सुरक्षा:
//  * मोबाइल + मूल निवास + अकना तीनों सही हों तभी जवाब (legacy जैसा)।
//  * Rate-limit: प्रति mobile 5/घंटा, प्रति IP 15/घंटा (migration 0020 का auth_rate_check)।
//  * पूरा email कभी response में नहीं — सिर्फ़ masked (ab**@gm***.com); पूरा email registered
//    पते पर ही mail होता है। Response में नाम भी नहीं।
//  * Census/unclaimed entries (auth_uid खाली) को कभी जवाब/mail नहीं।
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ── settings/email (inlined, register.ts जैसा) ──
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
let docsCache: { data: Record<string, Record<string, unknown>>; at: number } | null = null;
async function loadDocs(): Promise<Record<string, Record<string, unknown>>> {
  if (docsCache && Date.now() - docsCache.at < 60_000) return docsCache.data;
  const { data, error } = await createClient(SUPABASE_URL, SERVICE_ROLE_KEY).from("settings").select("doc_id, data");
  const map: Record<string, Record<string, unknown>> = {};
  if (!error && data) data.forEach((row) => { map[row.doc_id] = (row.data as Record<string, unknown>) || {}; });
  docsCache = { data: map, at: Date.now() };
  return map;
}
async function getSetting<T = unknown>(docId: string, key: string, fallback?: T): Promise<T> {
  const doc = (await loadDocs())[docId] || {};
  if (key in doc && doc[key] !== "" && doc[key] !== null) return doc[key] as T;
  return fallback as T;
}
async function getSecret(key: string): Promise<string | undefined> {
  const secrets = ((await loadDocs())["secrets"] || {}) as Record<string, string>;
  return secrets[key] || Deno.env.get(key.replace(/([A-Z])/g, "_$1").toUpperCase()) || undefined;
}
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const resendKey = await getSecret("resendApiKey");
  if (resendKey) {
    try {
      const from = await getSetting<string>("emailConfig", "emailFrom", "Gahoi Portal <noreply@jaigahoi.in>");
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, html }),
      });
      if (res.ok) return true;
    } catch (e) { console.error("Resend failed:", e); }
  }
  const brevoKey = await getSecret("brevoApiKey");
  if (!brevoKey) return false;
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", headers: { "api-key": brevoKey, "Content-Type": "application/json" },
      body: JSON.stringify({ sender: { email: await getSetting<string>("emailConfig", "emailFromAddress", "noreply@jaigahoi.in"), name: "Gahoi Portal" }, to: [{ email: to }], subject, htmlContent: html }),
    });
    return res.ok;
  } catch (e) { console.error("Brevo failed:", e); return false; }
}

// ── helpers ──
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
function looseMatch(stored: string, typed: string): boolean {
  if (stored.length < 2 || typed.length < 2) return stored === typed && stored.length > 0;
  return stored.includes(typed) || typed.includes(stored);
}
function maskEmail(email: string): string {
  const [local, domain = ""] = email.split("@");
  const parts = domain.split(".");
  return `${local.slice(0, 2)}**@${parts[0].slice(0, 2)}***.${parts.slice(1).join(".") || ""}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const mobile = String(body.mobile ?? "").replace(/\D/g, "").slice(-10);
    const native = norm(body.native), akna = norm(body.akna);
    if (!/^[6-9]\d{9}$/.test(mobile) || !native || !akna) {
      return jsonResponse({ success: false, message: "मोबाइल, मूल निवास और अकना — तीनों सही भरें।" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "noip";
    const [byIp, byMobile] = await Promise.all([
      admin.rpc("auth_rate_check", { p_key: "fuid:ip:" + ip, p_max: 15, p_window_minutes: 60 }),
      admin.rpc("auth_rate_check", { p_key: "fuid:m:" + mobile, p_max: 5, p_window_minutes: 60 }),
    ]);
    if (byIp.data === false || byMobile.data === false) {
      return jsonResponse({ success: false, message: "बहुत ज़्यादा कोशिशें हो गईं — एक घंटे बाद फिर प्रयास करें।" }, 429);
    }

    const NOT_FOUND = { success: false, message: "कोई account नहीं मिला। जाँचें कि मोबाइल, मूल निवास और अकना registration वाली जानकारी से ठीक वैसे ही मिलते हैं।" };
    const { data: person } = await admin.from("persons").select("name, native, akna, auth_uid").eq("mobile", mobile).maybeSingle();
    if (!person || !person.auth_uid) return jsonResponse(NOT_FOUND, 404);
    // User ने "reja" लिखा हो और stored "रेजा" — पहले typed अकना को akna_list से canonical Hindi में बदलो (migration 0021)
    const { data: canon } = await admin.rpc("canonical_akna", { p_text: String(body.akna ?? "") });
    const aknaOk = looseMatch(norm(person.akna), akna) || (canon ? norm(person.akna) === norm(canon) : false);
    if (!looseMatch(norm(person.native), native) || !aknaOk) return jsonResponse(NOT_FOUND, 404);

    const { data: u } = await admin.auth.admin.getUserById(person.auth_uid);
    const authUser = u?.user;
    if (!authUser) return jsonResponse(NOT_FOUND, 404);
    const providers: string[] = (authUser.app_metadata?.providers as string[]) || (authUser.app_metadata?.provider ? [authUser.app_metadata.provider as string] : []);
    const methods: string[] = [];
    if (providers.includes("email") || authUser.email) methods.push("email");
    if (providers.includes("google")) methods.push("google");
    if (authUser.phone) methods.push("phone");

    if (!authUser.email) {   // सिर्फ़ mobile-OTP वाला account
      return jsonResponse({ success: true, maskedEmail: "", methods, message: "आपका account बिना email के, सिर्फ़ मोबाइल से बना है — Login पेज पर 'Mobile OTP' से login करें।" });
    }

    const PORTAL_URL = (await getSetting<string>("publicConfig", "portalUrl", "")) || Deno.env.get("PORTAL_URL") || "https://jaigahoi.in";
    const how = methods.includes("google") && !providers.includes("email")
      ? "आप <b>Google</b> से login करते हैं — Login पेज पर \"Google से Login करें\" दबाएँ।"
      : "इसी email से login करें। Password याद न हो तो \"Password भूल गए?\" से नया बनाएँ।";
    const sent = await sendEmail(authUser.email, "🔑 गहोई पोर्टल — आपका Login Email",
      `<div style="font-family:Arial;max-width:560px;margin:0 auto;padding:20px">
        <h2 style="color:#7a1f3d">🔍 आपका Login Email</h2>
        <p>नमस्ते <b>${String(person.name || "").replace(/[<>&]/g, "")}</b> जी, आपने अपना Login Email पूछा था:</p>
        <div style="font-size:1.15rem;font-weight:800;text-align:center;padding:14px;background:#faf3e3;border-radius:8px;margin:14px 0">${authUser.email}</div>
        <p>${how}</p>
        <p style="text-align:center"><a href="${PORTAL_URL}/login.html" style="background:#d4940a;color:#3d0716;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:700">Login पेज</a></p>
        <p style="color:#888;font-size:.82rem">अगर आपने यह request नहीं की, तो इसे अनदेखा करें।</p></div>`);

    await admin.from("audit_log").insert({ action: "FIND_USER_ID", actor_name: "anonymous", target: maskEmail(authUser.email), detail: "mobile:" + mobile.slice(0, 2) + "******" + mobile.slice(-2), result: sent ? "SUCCESS" : "EMAIL_NOT_SENT" });

    return jsonResponse({
      success: true, maskedEmail: maskEmail(authUser.email), methods, emailed: sent,
      message: sent ? "आपका Login Email इसी पते पर भी भेज दिया गया है।" : "Email भेजने में दिक़्क़त हुई — ऊपर दिखे masked email से पहचानें, या Admin से संपर्क करें।",
    });
  } catch (e) {
    console.error("find-user-id error:", e);
    return jsonResponse({ success: false, message: "Server error — बाद में फिर कोशिश करें।" }, 500);
  }
});
