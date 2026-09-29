// ============================================================================
// Edge Function: broadcast-email
//
// मौजूदा Code.gs के doBroadcastEmail() का equivalent। Bulk-email client से सीधे
// नहीं हो सकती (ना auth_log लिखने के लिए RLS insert-policy है — जान-बूझकर सिर्फ़
// service_role लिख सकता है, ना ही सैकड़ों लोगों को personalized email एक साथ
// क्लाइंट JS से securely भेजना ठीक तरीक़ा है) — इसलिए यह छोटा-सा Function।
// Admin/Approver दोनों भेज सकते हैं (legacy जैसा)। _shared/email.ts का sendEmail()
// इस्तेमाल होता है, जो अपने-आप Resend → Brevo fallback करता है।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsPreflightRequest, jsonResponse } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface BroadcastPayload {
  subject: string;
  body: string;              // plain text/simple HTML — \n को <br> में बदल देंगे, legacy जैसा
  targetGahoiIds?: string[]; // ख़ाली/absent = सभी Approved members
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflightRequest(req);
  if (preflight) return preflight;

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return jsonResponse({ success: false, message: "Login required." }, 401);

    const anonClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await anonClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return jsonResponse({ success: false, message: "Invalid session." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: requester } = await admin
      .from("persons").select("gahoi_id, name, email, role").eq("auth_uid", userData.user.id).maybeSingle();
    if (!requester || (requester.role !== "Admin" && requester.role !== "Approver")) {
      return jsonResponse({ success: false, message: "Admin/Approver access required." }, 403);
    }

    const body: BroadcastPayload = await req.json();
    if (!body.subject || !body.body) {
      return jsonResponse({ success: false, message: "Subject and body are required." }, 400);
    }

    let query = admin.from("persons").select("gahoi_id, name, email").eq("status", "Approved").not("email", "is", null);
    if (body.targetGahoiIds && Array.isArray(body.targetGahoiIds) && body.targetGahoiIds.length > 0) {
      query = query.in("gahoi_id", body.targetGahoiIds);
    }
    const { data: recipients, error: recErr } = await query;
    if (recErr) return jsonResponse({ success: false, message: recErr.message }, 500);
    if (!recipients || recipients.length === 0) {
      return jsonResponse({ success: false, message: "No valid recipients found." }, 400);
    }

    let sent = 0, failed = 0;
    for (const r of recipients) {
      if (!r.email || !r.email.includes("@")) { failed++; continue; }
      try {
        const personalBody =
          `<p>Dear <strong>${r.name || "Member"}</strong>,</p>` +
          `<div style="padding:14px 0;line-height:1.8">${body.body.split("\n").join("<br>")}</div>` +
          `<hr style="border:none;border-top:1px solid #dde3ee;margin:16px 0">` +
          `<p style="font-size:.82rem;color:#7a8499">You are receiving this email as a registered member of Gahoi Portal.</p>`;
        const ok = await sendEmail({ to: r.email, subject: body.subject, html: personalBody });
        if (ok) sent++; else failed++;
      } catch (e) {
        console.error("Broadcast send failed for", r.email, e);
        failed++;
      }
    }

    // Sender को summary email — legacy जैसा
    if (requester.email) {
      try {
        await sendEmail({
          to: requester.email,
          subject: `[Sent] ${body.subject} — Broadcast Report`,
          html: `<h2>📣 Broadcast Report</h2><p>Your broadcast email has been sent.</p>` +
            `<div><strong>Subject:</strong> ${body.subject}<br><strong>Sent:</strong> ${sent} members<br>` +
            (failed ? `<strong>Failed:</strong> ${failed}<br>` : "") +
            `<strong>Sent by:</strong> ${requester.name}</div>`,
        });
      } catch (_e) { /* non-fatal */ }
    }

    await admin.from("audit_log").insert({
      action: "BROADCAST_EMAIL",
      actor_gahoi_id: requester.gahoi_id,
      actor_name: requester.name,
      actor_email: requester.email,
      target: `${sent} members`,
      detail: body.subject,
      result: `SUCCESS: ${sent} sent, ${failed} failed`,
    });

    return jsonResponse({ success: true, sent, failed });
  } catch (e) {
    console.error("broadcast-email error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
