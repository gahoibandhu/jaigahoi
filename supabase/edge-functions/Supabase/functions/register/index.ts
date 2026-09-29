// ============================================================================
// Edge Function: register
// भाग 1.2 — Supabase Auth से पहले ही signup/Google-OAuth हो चुका होता है (frontend
// से supabase.auth.signUp() या signInWithOAuth('google'))। ये Function उसके बाद
// बुलाया जाता है, profile-fields के साथ — असली `persons` row यहीं बनती है।
//
// मौजूदा Code.gs के doRegister() + doRegisterQuick() का Supabase-equivalent।
//
// ⚠️ इस file को इस sandbox में चलाकर टेस्ट नहीं किया जा सका (Deno/esm.sh जैसे
// domains यहाँ के network-sandbox में allowed नहीं) — SQL migrations जैसा runtime
// verification यहाँ मुमकिन नहीं था। Stage-1 local dev में `supabase functions serve`
// से टेस्ट करना ज़रूरी होगा, इसे "verified" ना मानें जब तक वो ना हो जाए।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsPreflightRequest, jsonResponse } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";
import { getSetting } from "../_shared/settings.ts";

// ADMIN_MOBILE/PORTAL_URL अब settings.ts से (module-level env-read की जगह
// request-time getSetting()) — GR के Admin Settings GUI से बदलने पर असर हो,
// इसलिए ये अब यहाँ const नहीं, हर request में handler के अंदर पढ़े जाते हैं।
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
  const { data } = await admin
    .from("akna_list")
    .select("hindi, english, variants")
    .eq("active", true);
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
    // ── 1. Caller की पहचान — JWT से (supabase.auth.signUp/signInWithOAuth के बाद
    //    frontend इस Function को Authorization header के साथ बुलाएगा) ──────────
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
    const emailVerified = !!authUser.email_confirmed_at || authUser.app_metadata?.provider === "google";

    // service-role client — RLS bypass करके duplicate-checks और insert करने के लिए
    // (मौजूदा Code.gs का doRegister() भी पूरी sheet access करता था, यही उसका equivalent)
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ── 2. पहले से registered तो नहीं? ───────────────────────────────────────
    const { data: existing } = await admin
      .from("persons")
      .select("gahoi_id")
      .eq("auth_uid", authUser.id)
      .maybeSingle();
    if (existing) {
      return jsonResponse({ success: false, message: "आप पहले से registered हैं।", gahoiId: existing.gahoi_id }, 409);
    }

    // ── 3. Input validation ──────────────────────────────────────────────────
    const body: RegisterPayload = await req.json();
    const required: (keyof RegisterPayload)[] = ["name", "father", "mobile", "city", "native", "akna"];
    for (const field of required) {
      if (!body[field] || String(body[field]).trim() === "") {
        return jsonResponse({ success: false, message: `Required field missing: ${field}` }, 400);
      }
    }

    const mobileCheck = isValidIndianMobile(body.mobile);
    if (!mobileCheck.ok) return jsonResponse({ success: false, message: mobileCheck.reason }, 400);

    const { data: mobileDupe } = await admin
      .from("persons")
      .select("gahoi_id")
      .eq("mobile", body.mobile)
      .maybeSingle();
    if (mobileDupe) return jsonResponse({ success: false, message: "Mobile already registered." }, 409);

    // ── 4. Akna validation + auto-approval decision ──────────────────────────
    const { recognized: aknaRecognized } = await validateAkna(admin, body.akna);
    const ADMIN_MOBILE = await getSetting<string>("appConfig", "adminMobile", "") || Deno.env.get("ADMIN_MOBILE") || "";
    const isAdmin = ADMIN_MOBILE !== "" && body.mobile === ADMIN_MOBILE;
    const autoApprove = isAdmin || (emailVerified && aknaRecognized);
    const status = autoApprove ? "Approved" : "Pending";

    // ── 5. Insert (gahoi_id column का DEFAULT generate_next_gahoi_id() से खुद बन जाएगा —
    //    atomic sequence, race-condition-free, भाग 1.8) ──────────────────────
    const { data: inserted, error: insertErr } = await admin
      .from("persons")
      .insert({
        auth_uid: authUser.id,
        name: body.name,
        father: body.father,
        mobile: body.mobile,
        email: authUser.email,
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

    // ── 6. Welcome email (Resend → Brevo fallback, भाग 1.6) ──────────────────
    if (authUser.email) {
      const PORTAL_URL = await getSetting<string>("publicConfig", "portalUrl", "") || Deno.env.get("PORTAL_URL") || "https://jaigahoi.in";
      await sendEmail({
        to: authUser.email,
        subject: autoApprove ? "🎉 Welcome to Gahoi Portal!" : "✅ Registration Received!",
        html: buildWelcomeEmailHtml(body.name, autoApprove, aknaRecognized, PORTAL_URL),
      });
    }

    // ── 7. Pending होने पर Admin/Approver को notify करना ──────────────────────
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

    // ── 8. Audit log ──────────────────────────────────────────────────────────
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
