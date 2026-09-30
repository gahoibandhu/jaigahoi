// ============================================================================
// Edge Function: add-akna
// मौजूदा Code.gs के doAddAkna() का Supabase-equivalent — akna_list एक ज़िंदा,
// admin-editable table है (hardcoded नहीं) — 222 entries सिर्फ़ initial seed थीं,
// उसके बाद नए akna यहीं से जुड़ते रहेंगे।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsPreflightRequest, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface AddAknaPayload {
  hindi?: string;
  english?: string;
  variants?: string;
  group?: string;   // akna_group — Advanced Search के "Akna Group" filter के लिए
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
      .from("persons")
      .select("gahoi_id, role")
      .eq("auth_uid", userData.user.id)
      .maybeSingle();

    if (!requester || (requester.role !== "Admin" && requester.role !== "Approver")) {
      return jsonResponse({ success: false, message: "Admin/Approver only." }, 403);
    }

    const body: AddAknaPayload = await req.json();
    if (!body.hindi && !body.english) {
      return jsonResponse({ success: false, message: "Hindi or English akna required." }, 400);
    }

    // ── Duplicate check — hindi/english/variants तीनों में देखना ──────────────
    const needle = (body.english || body.hindi || "").trim().toLowerCase();
    const { data: existingList } = await admin
      .from("akna_list")
      .select("hindi, english, variants")
      .eq("active", true);

    const dupe = (existingList || []).find((row) => {
      if (body.hindi && String(row.hindi || "").trim() === body.hindi.trim()) return true;
      if (String(row.english || "").trim().toLowerCase() === needle) return true;
      const variants = String(row.variants || "").toLowerCase().split(/[\s,]+/);
      return variants.includes(needle);
    });
    if (dupe) {
      return jsonResponse({ success: false, message: "Akna already exists.", matched: dupe }, 409);
    }

    const { error: insertErr } = await admin.from("akna_list").insert({
      hindi: body.hindi || "",
      english: body.english || "",
      variants: body.variants || body.english || "",
      akna_group: body.group || null,
      added_by: requester.gahoi_id,
    });

    if (insertErr) {
      return jsonResponse({ success: false, message: "Insert failed: " + insertErr.message }, 500);
    }

    return jsonResponse({ success: true, message: "Akna added." });
  } catch (e) {
    console.error("add-akna error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
