// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: admin-update-settings
// Admin-only (Approver नहीं — पूरे पोर्टल की config है)। Payload:
//   { docs: { publicConfig: {cloudinaryCloudName: "..."}, appConfig: {...} },
//     secrets: { cloudinaryApiSecret: "...", resendApiKey: "..." } }
// हर doc में सिर्फ़ भेजी गई keys merge होती हैं (पूरा doc overwrite नहीं) —
// ताकि एक field बदलने पर बाक़ी ग़लती से खाली ना हो जाएँ। secrets के values
// audit_log में कभी नहीं लिखे जाते — सिर्फ़ कौन-सा key बदला।
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
const KNOWN_DOC_IDS = ["publicConfig", "emailConfig", "appConfig", "featureFlags"];

interface UpdatePayload {
  docs?: Record<string, Record<string, unknown>>;
  secrets?: Record<string, string>;
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
      .from("persons").select("gahoi_id, name, email, role").eq("auth_uid", userData.user.id).maybeSingle();

    if (!requester || requester.role !== "Admin") {
      return jsonResponse({ success: false, message: "Admin only." }, 403);
    }

    const body: UpdatePayload = await req.json();
    const changedKeys: string[] = [];

    if (body.docs && typeof body.docs === "object") {
      for (const [docId, patch] of Object.entries(body.docs)) {
        if (!KNOWN_DOC_IDS.includes(docId)) {
          return jsonResponse({ success: false, message: `Unknown settings doc: "${docId}"` }, 400);
        }
        const { data: existing, error: readErr } = await admin
          .from("settings").select("data").eq("doc_id", docId).maybeSingle();
        if (readErr) return jsonResponse({ success: false, message: readErr.message }, 500);

        const merged = { ...((existing?.data as Record<string, unknown>) || {}), ...patch };
        const { error: writeErr } = await admin
          .from("settings").update({ data: merged }).eq("doc_id", docId);
        if (writeErr) return jsonResponse({ success: false, message: `"${docId}" save नहीं हुई: ${writeErr.message}` }, 500);

        Object.keys(patch).forEach((k) => changedKeys.push(`${docId}.${k}`));
      }
    }

    if (body.secrets && typeof body.secrets === "object") {
      const toSet: Record<string, string> = {};
      for (const [key, value] of Object.entries(body.secrets)) {
        if (value && String(value).trim()) toSet[key] = String(value).trim(); // खाली भेजकर ग़लती से secret मिटाना ना हो
      }
      if (Object.keys(toSet).length > 0) {
        const { data: existing, error: readErr } = await admin
          .from("settings").select("data").eq("doc_id", "secrets").maybeSingle();
        if (readErr) return jsonResponse({ success: false, message: readErr.message }, 500);

        const merged = { ...((existing?.data as Record<string, unknown>) || {}), ...toSet };
        const { error: writeErr } = await admin
          .from("settings").update({ data: merged }).eq("doc_id", "secrets");
        if (writeErr) return jsonResponse({ success: false, message: `secrets save नहीं हुई: ${writeErr.message}` }, 500);

        Object.keys(toSet).forEach((k) => changedKeys.push("secrets." + k)); // सिर्फ़ नाम — value कभी नहीं
      }
    }

    if (changedKeys.length === 0) {
      return jsonResponse({ success: false, message: "कोई settings/secrets भेजी नहीं गईं।" }, 400);
    }

    await admin.from("audit_log").insert({
      action: "ADMIN_UPDATE_SETTINGS",
      actor_gahoi_id: requester.gahoi_id,
      actor_name: requester.name,
      actor_email: requester.email,
      target: "settings",
      detail: "Updated: " + changedKeys.join(", "),
      result: "SUCCESS",
    });

    return jsonResponse({ success: true, updated: changedKeys });
  } catch (e) {
    console.error("admin-update-settings error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
