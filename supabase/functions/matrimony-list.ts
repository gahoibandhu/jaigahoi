// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: matrimony-list
// मौजूदा Code.gs के doMatList() + _matEffectivePhotos() का equivalent —
// Edge Function में इसलिए ज़रूरी है क्योंकि tier-based photo-limit (Gold=1,
// Platinum=2, Diamond=4) और expiry-check की logic column-masking है, RLS से
// नहीं होती (भाग 9.10 का वही नोट, अब तीसरी बार यही पैटर्न repeat हो रहा है —
// directory-search भी इसी वजह से Edge Function में था)।
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

const TIER_PHOTO_LIMIT: Record<string, number> = { Gold: 1, Platinum: 2, Diamond: 4 };

interface ListPayload {
  gender?: string;
  city?: string;
  ageMin?: number;
  ageMax?: number;
  page?: number;
}

const PAGE_SIZE = 12;

function effectivePhotos(photos: unknown, primaryPhoto: string, validUntil: string | null, tier: string) {
  let all: string[] = [];
  try {
    all = Array.isArray(photos) ? (photos as string[]) : JSON.parse(String(photos || "[]"));
  } catch {
    all = [];
  }
  all = all.filter(Boolean);
  if (!all.length && primaryPhoto) all = [primaryPhoto];

  let expired = false;
  if (validUntil) {
    expired = new Date(validUntil + "T23:59:59").getTime() < Date.now();
  }
  const limit = TIER_PHOTO_LIMIT[tier] || 1;
  const effective = expired ? all.slice(0, 1) : all.slice(0, limit);
  return { all, effective, expired };
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
      .select("gahoi_id, status")
      .eq("auth_uid", userData.user.id)
      .maybeSingle();
    if (!requester || requester.status !== "Approved") {
      return jsonResponse({ success: false, message: "Access denied." }, 403);
    }

    const body: ListPayload = await req.json().catch(() => ({}));
    const page = Math.max(1, body.page || 1);

    let query = admin
      .from("matrimony_profiles")
      .select(
        "id, created_by, status, gender, marital, name, dob, height, complexion, manglik, education, occupation, income, city, native, gotra, akna, tier, photo, photos, valid_until, job_company, job_city, verification, created_at",
        { count: "exact" },
      )
      .eq("status", "Approved")
      .is("deleted_at", null);

    if (body.gender) query = query.eq("gender", body.gender);
    if (body.city) query = query.ilike("city", `%${body.city}%`);

    query = query.order("created_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    const { data, error, count } = await query;
    if (error) return jsonResponse({ success: false, message: error.message }, 500);

    // इस user ने पहले से किन profiles में interest/shortlist भेजा है — UI में button-state के लिए
    const { data: myInterests } = await admin
      .from("matrimony_interests")
      .select("to_profile_id, type, status")
      .eq("from_gahoi_id", requester.gahoi_id);
    const myInterestMap = new Map((myInterests || []).map((i) => [`${i.to_profile_id}_${i.type}`, i.status]));

    const profiles = (data || []).map((p) => {
      const ep = effectivePhotos(p.photos, p.photo, p.valid_until, p.tier);
      const verification = (p.verification as Record<string, unknown>) || {};
      return {
        id: p.id,
        isOwn: p.created_by === requester.gahoi_id,
        gender: p.gender,
        marital: p.marital,
        name: p.name,
        dob: p.dob,
        height: p.height,
        complexion: p.complexion,
        manglik: p.manglik,
        education: p.education,
        occupation: p.occupation,
        income: p.income,
        city: p.city,
        native: p.native,
        gotra: p.gotra,
        akna: p.akna,
        tier: p.tier,
        photos: ep.effective,       // सिर्फ़ tier-limit तक, expired होने पर सिर्फ़ 1
        tierExpired: ep.expired,
        jobCompany: p.job_company,
        jobCity: p.job_city,
        verifiedBadge: verification.status === "verified",
        shortlisted: myInterestMap.get(`${p.id}_shortlist`) || null,
        interestStatus: myInterestMap.get(`${p.id}_interest`) || null,
        // mobile/contact जान-बूझकर कभी शामिल नहीं — सिर्फ़ mutual-interest के बाद email से भेजा जाता है
      };
    });

    return jsonResponse({
      success: true,
      profiles,
      total: count || 0,
      page,
      totalPages: Math.ceil((count || 0) / PAGE_SIZE),
    });
  } catch (e) {
    console.error("matrimony-list error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
