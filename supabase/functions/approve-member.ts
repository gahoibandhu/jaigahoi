// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: approve-member
// मौजूदा Code.gs के doApproveUser() का Supabase-equivalent — Admin/Approver
// किसी Pending member को Approve/Reject करता है, akna/role भी set कर सकता है।
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
const MAX_APPROVERS = 10;

interface ApprovePayload {
  targetGahoiId: string;
  status: "Approved" | "Rejected";
  akna?: string;
  role?: string;    // सिर्फ़ Admin सेट कर सकता है (Approver नहीं) — मौजूदा नियम जैसा
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflightRequest(req);
  if (preflight) return preflight;

  try {
    const PORTAL_URL = await getSetting<string>("publicConfig", "portalUrl", "") || Deno.env.get("PORTAL_URL") || "https://jaigahoi.in";
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return jsonResponse({ success: false, message: "Authentication required." }, 401);

    const anonClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await anonClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return jsonResponse({ success: false, message: "Invalid session." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ── कौन बुला रहा है — Admin/Approver ही ────────────────────────────────
    const { data: requester } = await admin
      .from("persons")
      .select("gahoi_id, name, email, role")
      .eq("auth_uid", userData.user.id)
      .maybeSingle();

    if (!requester || (requester.role !== "Admin" && requester.role !== "Approver")) {
      return jsonResponse({ success: false, message: "Access denied." }, 403);
    }

    const body: ApprovePayload = await req.json();
    if (!body.targetGahoiId || !body.status) {
      return jsonResponse({ success: false, message: "targetGahoiId and status required." }, 400);
    }

    // ── Role सिर्फ़ Admin बदल सकता है (Approver नहीं — मौजूदा नियम) ────────────
    if (body.role && requester.role !== "Admin") {
      return jsonResponse({ success: false, message: "Only Admin can change role." }, 403);
    }

    // ── Max-Approvers limit (मौजूदा MAX_APPROVERS=10 नियम) ────────────────────
    if (body.role === "Approver") {
      const { count } = await admin
        .from("persons")
        .select("gahoi_id", { count: "exact", head: true })
        .eq("role", "Approver");
      if ((count || 0) >= MAX_APPROVERS) {
        return jsonResponse({ success: false, message: "Max approvers reached." }, 400);
      }
    }

    const { data: target } = await admin
      .from("persons")
      .select("gahoi_id, name, email, mobile")
      .eq("gahoi_id", body.targetGahoiId)
      .maybeSingle();
    if (!target) return jsonResponse({ success: false, message: "Member not found." }, 404);

    // ── Update ──────────────────────────────────────────────────────────────
    const updateFields: Record<string, unknown> = { status: body.status };
    if (body.akna && body.akna.trim()) updateFields.akna = body.akna.trim();
    if (body.role) updateFields.role = body.role;
    // approved_by/at — मौजूदा Code.gs के doApproveUser() जैसा (audit-trail के लिए ज़रूरी)
    updateFields.approved_by = requester.gahoi_id;
    updateFields.approved_at = new Date().toISOString();

    const { error: updateErr } = await admin
      .from("persons")
      .update(updateFields)
      .eq("gahoi_id", body.targetGahoiId);

    if (updateErr) {
      return jsonResponse({ success: false, message: "Update failed: " + updateErr.message }, 500);
    }

    // ── Email + Audit ─────────────────────────────────────────────────────────
    if (body.status === "Approved" && target.email) {
      await sendEmail({
        to: target.email,
        subject: "🎉 Registration Successful! – Gahoi Portal",
        html: `<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#1a3a5c">🎉 Welcome, ${target.name}!</h2>
          <p>आपका account approve हो गया है — अभी login करें।</p>
          <p style="text-align:center"><a href="${PORTAL_URL}" style="background:#e8a020;color:#1a3a5c;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Login करें</a></p>
        </div>`,
      });
    } else if (body.status === "Rejected" && target.email) {
      await sendEmail({
        to: target.email,
        subject: "❌ Registration Not Approved – Gahoi Portal",
        html: `<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px">
          <h2>❌ Registration Not Approved</h2>
          <p>Dear ${target.name}, आपका registration अभी approve नहीं किया जा सका। किसी query के लिए gahoi.portal@gmail.com पर संपर्क करें।</p>
        </div>`,
      });
    }

    await admin.from("audit_log").insert({
      action: body.status === "Approved" ? "APPROVE" : "REJECT",
      actor_gahoi_id: requester.gahoi_id,
      actor_name: requester.name,
      actor_email: requester.email,
      target: `${target.name} <${target.email}>`,
      detail: body.role ? `Role: ${body.role}` : "",
      result: "SUCCESS",
    });

    return jsonResponse({ success: true });
  } catch (e) {
    console.error("approve-member error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
