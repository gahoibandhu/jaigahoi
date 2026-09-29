// ============================================================================
// Edge Function: referral-stats
//
// मौजूदा Code.gs के doGetReferralStats() का equivalent। यह service_role से
// चलना ज़रूरी है — persons_select_approved RLS policy (0005) किसी member को
// दूसरों की status='Pending' rows नहीं पढ़ने देती, चाहे वो खुद ही referrer क्यों
// ना हो। referrals.html को अपने referred लोगों का pending/joined दोनों तरह का
// हिसाब चाहिए (referredBy column अपनी ही row में देखकर भी नहीं पता चलता कि
// referred व्यक्ति की row किस status में है) — इसलिए यह छोटा-सा Function।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsPreflightRequest, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
      .select("gahoi_id, name, status")
      .eq("auth_uid", userData.user.id)
      .maybeSingle();
    if (!requester || requester.status !== "Approved") {
      return jsonResponse({ success: false, message: "Access denied." }, 403);
    }
    if (!requester.gahoi_id) {
      return jsonResponse({ success: false, message: "GahoiId not assigned." }, 400);
    }

    const { data: referred, error } = await admin
      .from("persons")
      .select("gahoi_id, name, photo, city, status, created_at")
      .eq("referred_by", requester.gahoi_id)
      .order("created_at", { ascending: false });
    if (error) return jsonResponse({ success: false, message: error.message }, 500);

    const rows = referred || [];
    const joined = rows.filter((m) => m.status === "Approved");
    const pending = rows.filter((m) => m.status === "Pending");
    const format = (m: Record<string, unknown>) => ({
      gahoiId: m.gahoi_id,
      name: m.name || "",
      photo: m.photo || "",
      city: m.city || "",
      status: m.status || "",
      joinedAt: m.created_at || "",
    });

    return jsonResponse({
      success: true,
      total: rows.length,
      joinedCount: joined.length,
      pendingCount: pending.length,
      joined: joined.map(format),
      pending: pending.map(format),
      myGahoiId: requester.gahoi_id,
      myName: requester.name,
    });
  } catch (e) {
    console.error("referral-stats error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
