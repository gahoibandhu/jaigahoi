// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: admin-set-role
// मौजूदा Code.gs के doSetRole() का equivalent — किसी भी (पहले से Approved)
// member का role बदलना, `approve-member` से अलग इसलिए क्योंकि वो सिर्फ़ Pending
// के approve/reject के साथ role सेट करता है — रोज़मर्रा में किसी मौजूदा member
// को बाद में Approver/mahasabhaPrint बनाना/हटाना एक अलग, बार-बार होने वाला
// operation है (Admin Panel का हिस्सा, भाग 8 का अगला कदम #1)।
//
// Admin-only (Approver नहीं) — मौजूदा नियम जैसा।
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_APPROVERS = 10;

// मौजूदा role-values (Code.gs भर में इस्तेमाल होने वाले) — free-text रखा गया है
// ताकि आगे कोई नया role (kshetriyaPanchayat/localPanchayat) जोड़ना migration
// के बिना हो सके, पर यहाँ जान-बूझकर एक allow-list रखी है ताकि टाइपो से कोई
// अनजाना role न बन जाए
const ALLOWED_ROLES = ["", "Admin", "Approver", "mahasabhaPrint", "kshetriyaPanchayat", "localPanchayat"];

interface SetRolePayload {
  targetGahoiId: string;
  role: string;
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
    if (userErr || !userData?.user) return jsonResponse({ success: false, message: "Invalid session." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: requester } = await admin
      .from("persons")
      .select("gahoi_id, name, email, role")
      .eq("auth_uid", userData.user.id)
      .maybeSingle();

    if (!requester || requester.role !== "Admin") {
      return jsonResponse({ success: false, message: "Admin only." }, 403);
    }

    const body: SetRolePayload = await req.json();
    if (!body.targetGahoiId || body.role === undefined) {
      return jsonResponse({ success: false, message: "targetGahoiId and role required." }, 400);
    }
    if (!ALLOWED_ROLES.includes(body.role)) {
      return jsonResponse({ success: false, message: "Unknown role: " + body.role }, 400);
    }

    const { data: target } = await admin
      .from("persons")
      .select("gahoi_id, name, email, role")
      .eq("gahoi_id", body.targetGahoiId)
      .maybeSingle();
    if (!target) return jsonResponse({ success: false, message: "Member not found." }, 404);

    // ── Max-Approvers limit (मौजूदा MAX_APPROVERS=10 नियम) ────────────────────
    if (body.role === "Approver" && target.role !== "Approver") {
      const { count } = await admin
        .from("persons")
        .select("gahoi_id", { count: "exact", head: true })
        .eq("role", "Approver");
      if ((count || 0) >= MAX_APPROVERS) {
        return jsonResponse({ success: false, message: "Max approvers reached." }, 400);
      }
    }

    // ── आख़िरी Admin को ख़ुद से Admin-पद हटाने से रोकना — पोर्टल कभी बिना Admin
    //    के न रह जाए (मौजूदा Code.gs में ADMIN_MOBILE का hardcoded protection था,
    //    यहाँ एक ज़्यादा सामान्य नियम — "कम-से-कम एक Admin हमेशा रहे")
    if (target.role === "Admin" && body.role !== "Admin") {
      const { count } = await admin
        .from("persons")
        .select("gahoi_id", { count: "exact", head: true })
        .eq("role", "Admin");
      if ((count || 0) <= 1) {
        return jsonResponse({ success: false, message: "Cannot remove the last remaining Admin." }, 400);
      }
    }

    const { error: updateErr } = await admin
      .from("persons")
      .update({ role: body.role })
      .eq("gahoi_id", body.targetGahoiId);

    if (updateErr) {
      return jsonResponse({ success: false, message: "Update failed: " + updateErr.message }, 500);
    }

    await admin.from("audit_log").insert({
      action: "SET_ROLE",
      actor_gahoi_id: requester.gahoi_id,
      actor_name: requester.name,
      actor_email: requester.email,
      target: `${target.name} <${target.email}>`,
      detail: `Role: ${target.role || "(none)"} → ${body.role || "(none)"}`,
      result: "SUCCESS",
    });

    return jsonResponse({ success: true, role: body.role });
  } catch (e) {
    console.error("admin-set-role error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
