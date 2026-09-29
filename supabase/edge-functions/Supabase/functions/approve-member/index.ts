// ============================================================================
// Edge Function: approve-member
// मौजूदा Code.gs के doApproveUser() का Supabase-equivalent — Admin/Approver
// किसी Pending member को Approve/Reject करता है, akna/role भी set कर सकता है।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsPreflightRequest, jsonResponse } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";
import { getSetting } from "../_shared/settings.ts";

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
