// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: razorpay-verify-payment
//
// razorpay-create-order का जोड़ीदार — signature verify करने के बाद `purpose` के
// हिसाब से सही table update करता है (matrimony tier / mahasabha membership /
// donation / panchayat membership / ad-booking)। नया purpose जोड़ना हो तो सिर्फ़
// नीचे के switch में एक case जोड़ना है — पूरा नया Function नहीं बनाना।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── _shared/cors.ts (inlined — Dashboard "Via Editor" multi-file folders resolve नहीं करता) ──
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface VerifyPayload {
  purpose: "matrimonyTier" | "mahasabhaMembership" | "donation" | "adBooking" | "panchayatMembership";
  referenceId?: string;
  orderId: string;
  paymentId: string;
  signature: string;
  amountPaise: number;
  extra?: Record<string, unknown>;   // purpose-specific अतिरिक्त data (जैसे tier नाम)
}

// HMAC-SHA256 verify — Web Crypto API से (Deno में built-in, कोई npm package नहीं चाहिए)
async function verifySignature(orderId: string, paymentId: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(`${orderId}|${paymentId}`));
  const expected = Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflightRequest(req);
  if (preflight) return preflight;

  try {
    const PORTAL_URL = await getSetting<string>("publicConfig", "portalUrl", "") || Deno.env.get("PORTAL_URL") || "https://jaigahoi.in";
    const body: VerifyPayload = await req.json();
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ⚠️ razorpay-create-order जैसा ही fix — donation के लिए JWT ज़रूरी नहीं
    // (anonymous donor भी payment verify करवा सके), बाक़ी हर purpose के लिए
    // अब भी ज़रूरी है।
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    let requester: { gahoi_id: string; name: string; email: string; mobile: string } | null = null;

    if (jwt) {
      const anonClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await anonClient.auth.getUser(jwt);
      if (userData?.user) {
        const { data: r } = await admin
          .from("persons").select("gahoi_id, name, email, mobile").eq("auth_uid", userData.user.id).maybeSingle();
        requester = r;
      }
    }

    if (body.purpose !== "donation" && !requester) {
      return jsonResponse({ success: false, message: "Authentication required." }, 401);
    }

    const RAZORPAY_KEY_SECRET = await getSecret("razorpayKeySecret") || Deno.env.get("RAZORPAY_KEY_SECRET") || "";
    if (!RAZORPAY_KEY_SECRET) {
      return jsonResponse({ success: false, message: "Server keys missing." }, 500);
    }

    // ── 1. Signature verify — सबसे पहले, बाक़ी कुछ भी करने से पहले ────────────
    const validSig = await verifySignature(body.orderId, body.paymentId, body.signature, RAZORPAY_KEY_SECRET);
    if (!validSig) {
      return jsonResponse({ success: false, message: "Signature mismatch — payment not verified." }, 400);
    }

    // donation receipt के लिए — anonymous donor का नाम/email login से नहीं,
    // create-order के वक़्त donations row में save हुए donor_name/donor_email से आता है
    let receiptTo: { email: string; name: string } | null = null;

    // ── 2. Purpose के हिसाब से dispatch ───────────────────────────────────────
    switch (body.purpose) {
      case "matrimonyTier": {
        const tier = String(body.extra?.tier || "Gold");
        const validityDays = tier === "Diamond" ? 365 : tier === "Platinum" ? 365 : 365;
        const validUntil = new Date(Date.now() + validityDays * 86400000).toISOString().slice(0, 10);
        const { error } = await admin
          .from("matrimony_profiles")
          .update({
            tier,
            tier_start_date: new Date().toISOString().slice(0, 10),
            valid_until: validUntil,
            status: "Approved",
            expiry_notified: "",
          })
          .eq("id", body.referenceId);
        if (error) return jsonResponse({ success: false, message: error.message }, 500);
        break;
      }

      case "mahasabhaMembership":
      case "panchayatMembership": {
        const { error } = await admin
          .from("panchayat_memberships")
          .update({ status: "Approved", payment_id: body.paymentId })
          .eq("id", body.referenceId);
        if (error) return jsonResponse({ success: false, message: error.message }, 500);
        break;
      }

      case "donation": {
        const { data: donation, error } = await admin
          .from("donations")
          .update({ status: "Success", payment_id: body.paymentId, receipt_sent: true })
          .eq("order_id", body.orderId)
          .select("donor_name, donor_email, campaign_id, amount")
          .maybeSingle();
        if (error) return jsonResponse({ success: false, message: error.message }, 500);
        if (donation?.donor_email) receiptTo = { email: donation.donor_email, name: donation.donor_name || "दानदाता" };
        // campaign की raised_amount बढ़ाना (atomic — RPC से, race-condition से बचने के लिए)
        if (donation?.campaign_id) {
          await admin.rpc("increment_campaign_raised", { p_campaign_id: donation.campaign_id, p_amount: donation.amount });
        }
        break;
      }

      case "adBooking": {
        const { error } = await admin
          .from("ads")
          .update({ status: "PendingApproval", payment_id: body.paymentId })
          .eq("id", body.referenceId);
        if (error) return jsonResponse({ success: false, message: error.message }, 500);
        break;
      }

      default:
        return jsonResponse({ success: false, message: "Unknown purpose: " + body.purpose }, 400);
    }

    // ── 3. Payment record (सभी purposes के लिए साझा confirmation-log) ─────────
    await admin.from("audit_log").insert({
      action: "PAYMENT_VERIFIED",
      actor_gahoi_id: requester?.gahoi_id,
      actor_name: requester?.name,
      actor_email: requester?.email,
      target: body.referenceId || "",
      detail: `Purpose:${body.purpose} PaymentId:${body.paymentId} Amount:${body.amountPaise / 100}`,
      result: "SUCCESS",
    });

    const emailTo = receiptTo || (requester?.email ? { email: requester.email, name: requester.name } : null);
    if (emailTo) {
      await sendEmail({
        to: emailTo.email,
        subject: "✅ Payment Successful – Gahoi Portal",
        html: `<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#1a3a5c">✅ Payment Successful!</h2>
          <p>Dear ${emailTo.name}, आपका payment (₹${body.amountPaise / 100}) सफलतापूर्वक प्राप्त हुआ।</p>
          <p style="text-align:center"><a href="${PORTAL_URL}" style="background:#e8a020;color:#1a3a5c;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Portal खोलें</a></p>
        </div>`,
      });
    }

    return jsonResponse({ success: true });
  } catch (e) {
    console.error("razorpay-verify-payment error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
