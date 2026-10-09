// ============================================================================
// Edge Function: register — SELF-CONTAINED बंडल्ड संस्करण
//
// ⚠️ ये file क्यों अलग है: Supabase Dashboard का "Via Editor" multi-file/_shared
// folder structure resolve नहीं कर पा रहा था ("Module not found _shared/cors.ts"
// error) — इसलिए यहाँ cors.ts/email.ts/settings.ts का पूरा code सीधे इसी file
// में inline कर दिया गया है, कोई relative import नहीं बचा। लॉजिक बिल्कुल वही है
// जो असली supabase/functions/register/index.ts में है — सिर्फ़ import की जगह
// inline किया गया है, ताकि ये Dashboard editor में अकेली file की तरह deploy हो
// सके। अगर बाद में CLI/GitHub-integration फिर से काम करने लगे, तो असली
// multi-file version (जो repo में है) ही source-of-truth रहेगा — ये bundled
// कॉपी सिर्फ़ emergency deployment के लिए है।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── _shared/cors.ts (inlined) ────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function handleCorsPreflightRequest(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── _shared/settings.ts (inlined) ────────────────────────────────────────
const SETTINGS_SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SETTINGS_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CACHE_TTL_MS = 60_000;

let docsCache: { data: Record<string, Record<string, unknown>>; at: number } | null = null;

function settingsAdminClient() {
  return createClient(SETTINGS_SUPABASE_URL, SETTINGS_SERVICE_ROLE_KEY);
}

async function loadDocs(): Promise<Record<string, Record<string, unknown>>> {
  if (docsCache && Date.now() - docsCache.at < CACHE_TTL_MS) return docsCache.data;
  const { data, error } = await settingsAdminClient().from("settings").select("doc_id, data");
  const map: Record<string, Record<string, unknown>> = {};
  if (!error && data) data.forEach((row) => { map[row.doc_id] = (row.data as Record<string, unknown>) || {}; });
  docsCache = { data: map, at: Date.now() };
  return map;
}

async function getSetting<T = unknown>(docId: string, key: string, fallback?: T): Promise<T> {
  const docs = await loadDocs();
  const doc = docs[docId] || {};
  if (key in doc && doc[key] !== "" && doc[key] !== null) return doc[key] as T;
  const envVal = Deno.env.get(key.replace(/([A-Z])/g, "_$1").toUpperCase());
  if (envVal !== undefined) return envVal as unknown as T;
  return fallback as T;
}

async function getSecret(key: string): Promise<string | undefined> {
  const docs = await loadDocs();
  const secrets = (docs["secrets"] || {}) as Record<string, string>;
  if (secrets[key]) return secrets[key];
  const envKey = key.replace(/([A-Z])/g, "_$1").toUpperCase();
  return Deno.env.get(envKey) || undefined;
}

// ── _shared/email.ts (inlined) ───────────────────────────────────────────
interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

async function sendViaResend(input: SendEmailInput): Promise<boolean> {
  const apiKey = await getSecret("resendApiKey");
  if (!apiKey) return false;
  try {
    const from = await getSetting<string>("emailConfig", "emailFrom", "Gahoi Portal <noreply@jaigahoi.in>");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html }),
    });
    return res.ok;
  } catch (e) {
    console.error("Resend send failed:", e);
    return false;
  }
}

async function sendViaBrevo(input: SendEmailInput): Promise<boolean> {
  const apiKey = await getSecret("brevoApiKey");
  if (!apiKey) return false;
  try {
    const fromAddress = await getSetting<string>("emailConfig", "emailFromAddress", "noreply@jaigahoi.in");
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { email: fromAddress, name: "Gahoi Portal" },
        to: [{ email: input.to }],
        subject: input.subject,
        htmlContent: input.html,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("Brevo send failed:", e);
    return false;
  }
}

async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const okResend = await sendViaResend(input);
  if (okResend) return true;
  console.warn("Resend failed/unavailable, falling back to Brevo:", input.to);
  return await sendViaBrevo(input);
}

// ── register function की असली logic (unchanged) ─────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface RegisterPayload {
  name: string;
  father: string;
  mobile: string;
  city: string;
  native: string;
  akna: string;
  profession?: string;
  designation?: string;
  address?: string;
  pincode?: string;
  bday?: string;
  anni?: string;
  marital?: string;
  spouse?: string;
  email?: string;   // सिर्फ़ Mobile-OTP वाले (बिना email) accounts के लिए वैकल्पिक
  photo?: string;
  bloodGroup?: string;
  keywords?: string;
  referrerGahoiId?: string;
}

function isValidIndianMobile(mobile: string): { ok: boolean; reason?: string } {
  if (!/^\d{10}$/.test(mobile)) return { ok: false, reason: "Mobile must be exactly 10 digits" };
  if (/^(\d)\1{9}$/.test(mobile)) return { ok: false, reason: "Invalid mobile (all digits same)" };
  if (!/^[6-9]/.test(mobile)) return { ok: false, reason: "Indian mobile must start with 6, 7, 8, or 9" };
  if (["0123456789", "1234567890", "9876543210"].includes(mobile)) {
    return { ok: false, reason: "Invalid mobile pattern" };
  }
  return { ok: true };
}

async function validateAkna(
  admin: ReturnType<typeof createClient>,
  akna: string,
): Promise<{ recognized: boolean }> {
  if (!akna) return { recognized: false };
  const needle = akna.trim().toLowerCase();
  const { data } = await admin.from("akna_list").select("hindi, english, variants").eq("active", true);
  if (!data) return { recognized: false };
  for (const row of data) {
    if (String(row.hindi || "").trim() === akna.trim()) return { recognized: true };
    if (String(row.english || "").trim().toLowerCase() === needle) return { recognized: true };
    const variants = String(row.variants || "").toLowerCase().split(/[\s,]+/);
    if (variants.includes(needle)) return { recognized: true };
  }
  return { recognized: false };
}

function buildWelcomeEmailHtml(name: string, autoApproved: boolean, aknaRecognized: boolean, portalUrl: string): string {
  if (autoApproved) {
    return `<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px">
      <h2 style="color:#1a3a5c">🎉 Welcome to Gahoi Portal!</h2>
      <p>Namaste <strong>${name}</strong>! आपका account approve हो गया है — अभी login करें।</p>
      <p style="text-align:center;margin:20px 0">
        <a href="${portalUrl}" style="background:#1a3a5c;color:#e8a020;padding:12px 30px;text-decoration:none;border-radius:8px;font-weight:bold">Login करें</a>
      </p>
      <p style="color:#666;font-size:.85rem;text-align:center">— Gahoi Portal Team</p>
    </div>`;
  }
  return `<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px">
    <h2 style="color:#1a3a5c">✅ Registration Received</h2>
    <p>Namaste <strong>${name}</strong>! आपका registration admin की समीक्षा में है।</p>
    ${aknaRecognized ? "" : `<p style="background:#fff3cd;padding:10px;border-radius:6px;color:#856404">⚠ आपका akna हमारी verified list में नहीं मिला — Admin इसे review करेंगे।</p>`}
    <p>Approval होने पर आपको ईमेल मिलेगी (आमतौर पर 24 घंटे के अंदर)।</p>
  </div>`;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflightRequest(req);
  if (preflight) return preflight;

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return jsonResponse({ success: false, message: "Authentication required." }, 401);

    const anonClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await anonClient.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return jsonResponse({ success: false, message: "Invalid session." }, 401);
    }
    const authUser = userData.user;
    // Verified संपर्क: email-confirm, Google, या (नया) Mobile-OTP से verified phone।
    // Phone वाला account तभी verified माना जाए जब Supabase ने phone_confirmed_at भरा हो।
    const phoneVerified = !!authUser.phone_confirmed_at;
    const emailVerified = !!authUser.email_confirmed_at || authUser.app_metadata?.provider === "google" || phoneVerified;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: existing } = await admin
      .from("persons")
      .select("gahoi_id")
      .eq("auth_uid", authUser.id)
      .maybeSingle();
    if (existing) {
      return jsonResponse({ success: false, message: "आप पहले से registered हैं।", gahoiId: existing.gahoi_id }, 409);
    }

    const body: RegisterPayload = await req.json();
    const required: (keyof RegisterPayload)[] = ["name", "father", "mobile", "city", "native", "akna"];
    for (const field of required) {
      if (!body[field] || String(body[field]).trim() === "") {
        return jsonResponse({ success: false, message: `Required field missing: ${field}` }, 400);
      }
    }

    const mobileCheck = isValidIndianMobile(body.mobile);
    if (!mobileCheck.ok) return jsonResponse({ success: false, message: mobileCheck.reason }, 400);

    // Mobile-OTP से बना account: form का mobile वही होना चाहिए जो OTP से verify हुआ (spoofing रोकने के लिए)
    if (authUser.phone) {
      const verifiedMobile = String(authUser.phone).replace(/\D/g, "").slice(-10);
      if (body.mobile !== verifiedMobile) {
        return jsonResponse({ success: false, message: "Mobile नंबर वही होना चाहिए जो OTP से verify हुआ है।" }, 400);
      }
    }

    const { data: mobileDupe } = await admin
      .from("persons")
      .select("gahoi_id")
      .eq("mobile", body.mobile)
      .maybeSingle();
    if (mobileDupe) return jsonResponse({ success: false, message: "Mobile already registered." }, 409);

    const { recognized: aknaRecognized } = await validateAkna(admin, body.akna);
    const ADMIN_MOBILE = await getSetting<string>("appConfig", "adminMobile", "") || Deno.env.get("ADMIN_MOBILE") || "";
    const isAdmin = ADMIN_MOBILE !== "" && body.mobile === ADMIN_MOBILE;
    const autoApprove = isAdmin || (emailVerified && aknaRecognized);
    const status = autoApprove ? "Approved" : "Pending";

    const { data: inserted, error: insertErr } = await admin
      .from("persons")
      .insert({
        auth_uid: authUser.id,
        name: body.name,
        father: body.father,
        mobile: body.mobile,
        email: authUser.email || (body.email ? String(body.email).trim().toLowerCase() : null),
        city: body.city,
        native: body.native,
        akna: body.akna,
        profession: body.profession || "",
        designation: body.designation || "",
        address: body.address || "",
        pincode: body.pincode || "",
        bday: body.bday || "",
        anni: body.anni || "",
        marital: body.marital || "Unmarried",
        spouse: body.spouse || "",
        photo: body.photo || "",
        blood_group: body.bloodGroup || "",
        keywords: (body.keywords || "").split(",").map((k) => k.trim()).filter(Boolean).slice(0, 5),
        status,
        role: isAdmin ? "Admin" : "",
        referred_by: (body.referrerGahoiId || "").trim().toUpperCase(),
      })
      .select("gahoi_id")
      .single();

    if (insertErr || !inserted) {
      console.error("Insert failed:", insertErr);
      return jsonResponse({ success: false, message: "Registration failed: " + insertErr?.message }, 500);
    }

    if (authUser.email) {
      const PORTAL_URL = await getSetting<string>("publicConfig", "portalUrl", "") || Deno.env.get("PORTAL_URL") || "https://jaigahoi.in";
      await sendEmail({
        to: authUser.email,
        subject: autoApprove ? "🎉 Welcome to Gahoi Portal!" : "✅ Registration Received!",
        html: buildWelcomeEmailHtml(body.name, autoApprove, aknaRecognized, PORTAL_URL),
      });
    }

    if (!autoApprove) {
      const { data: notifyList } = await admin
        .from("persons")
        .select("email")
        .in("role", ["Admin", "Approver"]);
      for (const admin_person of notifyList || []) {
        if (admin_person.email) {
          await sendEmail({
            to: admin_person.email,
            subject: `⏳ Pending Approval: ${body.name}${aknaRecognized ? "" : " [⚠ Akna unrecognized]"}`,
            html: `<p>${body.name} (${body.mobile}) ने register किया — Admin Panel से approve करें।</p>`,
          });
        }
      }
    }

    await admin.from("audit_log").insert({
      action: "REGISTER",
      actor_gahoi_id: inserted.gahoi_id,
      actor_name: body.name,
      actor_email: authUser.email,
      target: authUser.email,
      detail: `City:${body.city} Akna:${body.akna} Mobile:${body.mobile}`,
      result: isAdmin ? "SUCCESS (Admin)" : autoApprove ? "SUCCESS (Auto-Approved)" : "SUCCESS (Pending)",
    });

    return jsonResponse({
      success: true,
      gahoiId: inserted.gahoi_id,
      status,
      autoApproved: autoApprove,
      aknaRecognized,
    });
  } catch (e) {
    console.error("register function error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
