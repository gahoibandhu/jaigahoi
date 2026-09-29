// ============================================================================
// Edge Function: razorpay-verify-payment
//
// razorpay-create-order का जोड़ीदार — signature verify करने के बाद `purpose` के
// हिसाब से सही table update करता है (matrimony tier / mahasabha membership /
// donation / panchayat membership / ad-booking)। नया purpose जोड़ना हो तो सिर्फ़
// नीचे के switch में एक case जोड़ना है — पूरा नया Function नहीं बनाना।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsPreflightRequest, jsonResponse } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";
import { getSecret, getSetting } from "../_shared/settings.ts";

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
