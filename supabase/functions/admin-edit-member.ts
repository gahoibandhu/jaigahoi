// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: admin-edit-member
// मौजूदा Code.gs के doAdminEditMember() का equivalent — Admin/Approver किसी भी
// member की profile-fields edit कर सकते हैं (email कभी नहीं — login-identity है)।
//
// Edge Function में क्यों (सीधे supabase-js से नहीं, जबकि profile.html अपनी ख़ुद
// की row के लिए सीधे supabase-js इस्तेमाल करता है):
//   1. हर edit audit_log में जाना चाहिए — audit_log पर कोई भी client-side insert
//      policy नहीं है (जान-बूझकर, भाग 9 का "कोई भी सीधे नहीं लिख सकता" नोट), सिर्फ़
//      service_role/SECURITY DEFINER से ही लिखा जा सकता है।
//   2. Approver बनाम Admin का field-level फ़र्क़ (status/role सिर्फ़ Admin बदल सकता
//      है, Approver बाक़ी fields बदल सकता है) — मौजूदा doAdminEditMember() जैसा।
//
// ⚠️ यह migration 0009 के फिक्स पर निर्भर करता है — उससे पहले service_role से
// आया कोई भी status/role update ट्रिगर द्वारा चुपचाप वापस पुरानी value पर पलट
// दिया जाता था (देखें 0009_fix_service_role_privileged_fields.sql का कमेंट)।
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

// मौजूदा doAdminEditMember() जैसा — email यहाँ जान-बूझकर शामिल नहीं (login-identity,
// कभी नहीं बदलती, यही मौजूदा नियम है)
const DIRECT_FIELDS = [
  "name", "father", "mobile", "profession", "designation", "address",
  "city", "pincode", "native", "akna", "blood_group", "bday", "anni",
  "marital", "spouse", "show_mobile", "keywords",
] as const;

// profile jsonb के अंदर के fields (directory-search/matrimony-list में इस्तेमाल
// होने वाले profile.* keys से consistent)
const PROFILE_FIELDS = [
  "streetAddress", "locality", "landmark", "linkedin", "twitter",
  "instagram", "facebook", "hobbies", "school", "bio",
] as const;

// सिर्फ़ Admin बदल सकता है (Approver नहीं) — मौजूदा नियम जैसा
const ADMIN_ONLY_FIELDS = ["status"] as const;

interface EditPayload {
  targetGahoiId: string;
  fields: Record<string, unknown>;
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

    if (!requester || (requester.role !== "Admin" && requester.role !== "Approver")) {
      return jsonResponse({ success: false, message: "Access denied." }, 403);
    }

    const body: EditPayload = await req.json();
    if (!body.targetGahoiId || !body.fields || typeof body.fields !== "object") {
      return jsonResponse({ success: false, message: "targetGahoiId and fields required." }, 400);
    }

    const { data: target } = await admin
      .from("persons")
      .select("gahoi_id, name, email, mobile, profile")
      .eq("gahoi_id", body.targetGahoiId)
      .maybeSingle();
    if (!target) return jsonResponse({ success: false, message: "Member not found." }, 404);

    // ── Mobile validate + uniqueness (मौजूदा नियम जैसा) ────────────────────────
    if (typeof body.fields.mobile === "string" && body.fields.mobile.trim()) {
      const newMobile = body.fields.mobile.trim();
      if (!/^\d{10}$/.test(newMobile)) {
        return jsonResponse({ success: false, message: "Mobile must be 10 digits." }, 400);
      }
      if (newMobile !== target.mobile) {
        const { data: clash } = await admin
          .from("persons")
          .select("gahoi_id")
          .eq("mobile", newMobile)
          .neq("gahoi_id", body.targetGahoiId)
          .maybeSingle();
        if (clash) {
          return jsonResponse({ success: false, message: "This mobile is already registered to another member." }, 400);
        }
      }
    }

    const updateFields: Record<string, unknown> = {};
    const changes: string[] = [];
    const profileUpdate: Record<string, unknown> = { ...((target.profile as Record<string, unknown>) || {}) };
    let profileTouched = false;

    for (const [key, value] of Object.entries(body.fields)) {
      if ((ADMIN_ONLY_FIELDS as readonly string[]).includes(key)) {
        if (requester.role !== "Admin") {
          return jsonResponse({ success: false, message: "Approvers cannot change status." }, 403);
        }
        updateFields[key] = value;
        changes.push(key);
        continue;
      }
      if ((DIRECT_FIELDS as readonly string[]).includes(key)) {
        updateFields[key] = value;
        changes.push(key);
        continue;
      }
      if ((PROFILE_FIELDS as readonly string[]).includes(key)) {
        profileUpdate[key] = value;
        profileTouched = true;
        changes.push("profile." + key);
        continue;
      }
      // role यहाँ जान-बूझकर स्वीकार नहीं — role बदलने के लिए अलग `admin-set-role`
      // function है (MAX_APPROVERS-जैसे अलग नियम हैं, इसे यहाँ मिलाना ग़लती होगी)
    }

    if (profileTouched) updateFields.profile = profileUpdate;

    if (Object.keys(updateFields).length === 0) {
      return jsonResponse({ success: false, message: "No editable fields provided." }, 400);
    }

    const { error: updateErr } = await admin
      .from("persons")
      .update(updateFields)
      .eq("gahoi_id", body.targetGahoiId);

    if (updateErr) {
      return jsonResponse({ success: false, message: "Update failed: " + updateErr.message }, 500);
    }

    await admin.from("audit_log").insert({
      action: "ADMIN_EDIT_MEMBER",
      actor_gahoi_id: requester.gahoi_id,
      actor_name: requester.name,
      actor_email: requester.email,
      target: `${target.name} <${target.email}>`,
      detail: "Edited: " + changes.join(", "),
      result: "SUCCESS",
    });

    const { data: updated } = await admin
      .from("persons")
      .select("*")
      .eq("gahoi_id", body.targetGahoiId)
      .maybeSingle();

    return jsonResponse({ success: true, member: updated });
  } catch (e) {
    console.error("admin-edit-member error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
