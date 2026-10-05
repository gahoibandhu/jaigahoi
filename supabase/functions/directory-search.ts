// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: directory-search
// मौजूदा Code.gs के doSearch()/doMemberList() का equivalent — ज़रूरी इसलिए Edge
// Function में है (सीधे supabase-js से नहीं) क्योंकि यहाँ column-level privacy
// masking चाहिए (mobile/spouse/birthday/social सिर्फ़ privacy_settings/showMobile
// के हिसाब से दिखें) — RLS सिर्फ़ row-level करती है, column-level नहीं
// (भाग 9.10 का नोट, 0005_rls_policies.sql में विस्तार से)।
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

interface SearchPayload {
  q?: string;             // free-text — name/city/native/akna/profession पर
  name?: string;
  city?: string;
  native?: string;
  akna?: string;
  bloodGroup?: string;
  sort?: "name_asc" | "name_desc" | "recent";
  page?: number;
}

const PAGE_SIZE = 10;

// मौजूदा safeUser()/doMemberList() जैसा — privacy_settings के हिसाब से fields मास्क करना
function maskMember(row: Record<string, unknown>) {
  const privacy = (row.privacy_settings as Record<string, string>) || {};
  const socialVisible = privacy.socialLinks !== "hidden";
  const profile = (row.profile as Record<string, unknown>) || {};

  return {
    gahoiId: row.gahoi_id,
    name: row.name,
    city: row.city,
    native: row.native,
    akna: row.akna,
    profession: row.profession,
    designation: row.designation,
    photo: row.photo || "",
    bloodGroup: row.blood_group || "",
    marital: row.marital,
    father: row.father || "",
    keywords: row.keywords || [],
    profileTier: row.profile_tier || "Bronze",

    address: privacy.address !== "hidden" ? (row.address || "") : "",
    spouse: privacy.spouse !== "hidden" ? (row.spouse || "") : "",
    bday: privacy.birthday !== "hidden" ? (row.bday || "") : "",
    anni: privacy.anniversary !== "hidden" ? (row.anni || "") : "",
    mobile: (row.show_mobile || "yes") !== "no" && privacy.mobile !== "hidden" ? (row.mobile || "") : "",

    bio: profile.bio || "",
    hobbies: profile.hobbies || "",
    school: profile.school || "",
    linkedin: socialVisible ? (profile.linkedin || "") : "",
    twitter: socialVisible ? (profile.twitter || "") : "",
    instagram: socialVisible ? (profile.instagram || "") : "",
    facebook: socialVisible ? (profile.facebook || "") : "",
  };
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
      .select("status")
      .eq("auth_uid", userData.user.id)
      .maybeSingle();
    if (!requester || requester.status !== "Approved") {
      return jsonResponse({ success: false, message: "Access denied." }, 403);
    }

    const body: SearchPayload = await req.json().catch(() => ({}));
    const page = Math.max(1, body.page || 1);

    let query = admin
      .from("persons")
      .select(
        "gahoi_id, name, father, city, native, akna, profession, designation, photo, blood_group, marital, spouse, bday, anni, address, show_mobile, mobile, keywords, profile, privacy_settings, profile_tier",
        { count: "exact" },
      )
      .eq("status", "Approved");

    if (body.name) query = query.ilike("name", `%${body.name}%`);
    if (body.city) query = query.ilike("city", `%${body.city}%`);
    if (body.native) query = query.ilike("native", `%${body.native}%`);
    if (body.akna) query = query.ilike("akna", `%${body.akna}%`);
    if (body.bloodGroup) query = query.eq("blood_group", body.bloodGroup);
    if (body.q) {
      // Postgres का पहले बनाया gin-index (idx_persons_search) यहाँ काम आता है,
      // पर PostgREST से full-text query सीधे भेजना जटिल है — अभी OR-ilike से (छोटे data-size तक ठीक),
      // बड़ा होने पर to_tsquery() based RPC function में बदलना होगा
      const q = `%${body.q}%`;
      query = query.or(
        `name.ilike.${q},city.ilike.${q},native.ilike.${q},akna.ilike.${q},profession.ilike.${q}`,
      );
    }

    if (body.sort === "name_desc") query = query.order("name", { ascending: false });
    else if (body.sort === "recent") query = query.order("created_at", { ascending: false });
    else query = query.order("name", { ascending: true });

    query = query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    const { data, error, count } = await query;
    if (error) return jsonResponse({ success: false, message: error.message }, 500);

    return jsonResponse({
      success: true,
      members: (data || []).map(maskMember),
      total: count || 0,
      page,
      totalPages: Math.ceil((count || 0) / PAGE_SIZE),
    });
  } catch (e) {
    console.error("directory-search error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
