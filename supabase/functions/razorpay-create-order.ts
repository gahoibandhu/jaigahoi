// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: razorpay-create-order
//
// मौजूदा Code.gs में doMatCreateOrder() और doMahasabhaCreateOrder() लगभग
// हूबहू (near-duplicate) कोड थे। यहाँ एक ही generic Function है जो `purpose` के
// आधार पर काम करता है — donation/ad-booking/panchayat-membership के लिए भी यही
// इस्तेमाल होगा, कोई नया duplicate function नहीं बनाना पड़ेगा।
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

// ── _shared/settings.ts (inlined) ────────────────────────────────────────
const SETTINGS_SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SETTINGS_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CACHE_TTL_MS = 60_000;

let docsCache: { data: Record<string, Record<string, unknown>>; at: number } | null = null;

function settingsAdminClient() {
  return createClient(SETTINGS_SUPABASE_URL, SETTINGS_SERVICE_ROLE_KEY);
}

async function loadDocs(): Promise<Record<string, Record<string, unknown>>> {
  if (docsCache && Date.now() - docsCache.at < CACHE_TTL_MS) return docsCache.data;
  const { data, error } = await settingsAdminClient().from("settings").select("doc_id, data");
  const map: Record<string, Record<string, unknown>> = {};
  if (!error && data) data.forEach((row) => { map[row.doc_id] = (row.data as Record<string, unknown>) || {}; });
  docsCache = { data: map, at: Date.now() };
  return map;
}

async function getSetting<T = unknown>(docId: string, key: string, fallback?: T): Promise<T> {
  const docs = await loadDocs();
  const doc = docs[docId] || {};
  if (key in doc && doc[key] !== "" && doc[key] !== null) return doc[key] as T;
  const envVal = Deno.env.get(key.replace(/([A-Z])/g, "_$1").toUpperCase());
  if (envVal !== undefined) return envVal as unknown as T;
  return fallback as T;
}

async function getSecret(key: string): Promise<string | undefined> {
  const docs = await loadDocs();
  const secrets = (docs["secrets"] || {}) as Record<string, string>;
  if (secrets[key]) return secrets[key];
  const envKey = key.replace(/([A-Z])/g, "_$1").toUpperCase();
  return Deno.env.get(envKey) || undefined;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// समर्थित purposes — नया purpose जोड़ना हो तो सिर्फ़ यहाँ + verify-payment में एक case जोड़ना है
type Purpose = "matrimonyTier" | "mahasabhaMembership" | "donation" | "adBooking" | "panchayatMembership";

interface CreateOrderPayload {
  purpose: Purpose;
  referenceId?: string;   // matrimony profile id / panchayat membership id आदि — donation में ज़रूरी नहीं
  amountPaise: number;    // राशि पहले से paise में frontend/Edge Function से आनी चाहिए
  notes?: Record<string, string>;
  // सिर्फ़ purpose='donation' के लिए — बिना लॉगिन के भी कोई donate कर सके
  campaignId?: string;
  donorName?: string;
  donorMobile?: string;
  donorEmail?: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflightRequest(req);
  if (preflight) return preflight;

  try {
    const body: CreateOrderPayload = await req.json();
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ⚠️ पहले यहाँ हर purpose के लिए JWT ज़रूरी था — donation के लिए भी, जो
    // डिज़ाइन-इरादे (comment में "अनजान visitors भी कर सकते हैं", RLS में
    // donations_insert "anonymous donors भी कर सकते हैं") के उलट था। Fix:
    // JWT सिर्फ़ तभी पढ़ें/ज़रूरी मानें जब भेजा गया हो — ना हो तो अनाम donor
    // मानें (donation के अलावा हर purpose के लिए अब भी JWT ज़रूरी है)।
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    let requester: { gahoi_id: string; email: string; status: string } | null = null;

    if (jwt) {
      const anonClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await anonClient.auth.getUser(jwt);
      if (userData?.user) {
        const { data: r } = await admin
          .from("persons").select("gahoi_id, email, status").eq("auth_uid", userData.user.id).maybeSingle();
        requester = r;
      }
    }

    if (body.purpose !== "donation" && (!jwt || !requester || requester.status !== "Approved")) {
      return jsonResponse({ success: false, message: "Access denied." }, body.purpose !== "donation" && !jwt ? 401 : 403);
    }

    const RAZORPAY_KEY_ID = await getSetting<string>("publicConfig", "razorpayKeyId", "") || Deno.env.get("RAZORPAY_KEY_ID") || "";
    const RAZORPAY_KEY_SECRET = await getSecret("razorpayKeySecret") || Deno.env.get("RAZORPAY_KEY_SECRET") || "";
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      return jsonResponse({ success: false, message: "Razorpay keys not configured." }, 500);
    }
    if (!body.amountPaise || body.amountPaise < 100) {
      return jsonResponse({ success: false, message: "Invalid amount." }, 400);
    }

    const receipt = `${body.purpose}_${body.referenceId || "na"}_${Date.now()}`;
    const razorpayRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      },
      body: JSON.stringify({
        amount: body.amountPaise,
        currency: "INR",
        receipt,
        notes: { purpose: body.purpose, referenceId: body.referenceId || "", ...(body.notes || {}) },
      }),
    });

    const razorpayBody = await razorpayRes.json();
    if (!razorpayRes.ok || !razorpayBody.id) {
      return jsonResponse({
        success: false,
        message: razorpayBody?.error?.description || "Order create failed.",
      }, 502);
    }

    let donationId: string | undefined;
    if (body.purpose === "donation") {
      // ⚠️ donations table पर कोई client-side UPDATE policy नहीं है (जान-बूझकर
      // — audit जैसा पैटर्न), और anonymous donor अपनी ही insert की हुई row
      // वापस SELECT भी नहीं कर सकता (RLS: donor_gahoi_id = current_gahoi_id(),
      // दोनों तरफ़ NULL होने पर भी बराबर नहीं गिना जाता) — इसलिए donations row
      // यहीं, order_id समेत, एक ही साथ बना दी जाती है। बाद में अलग से update
      // करने की ज़रूरत ही नहीं पड़ती (razorpay-verify-payment सिर्फ़ status
      // 'Success' करता है, वही काफ़ी है)।
      const { data: donation, error: donationErr } = await admin
        .from("donations")
        .insert({
          campaign_id: body.campaignId || null,
          donor_gahoi_id: requester?.gahoi_id || null,
          donor_name: body.donorName || null,
          donor_mobile: body.donorMobile || null,
          donor_email: body.donorEmail || requester?.email || null,
          amount: body.amountPaise / 100,
          order_id: razorpayBody.id,
          status: "Pending",
        })
        .select("id")
        .single();
      if (donationErr) {
        return jsonResponse({ success: false, message: "Order तो बन गया पर donation record नहीं बना: " + donationErr.message }, 500);
      }
      donationId = donation.id;
    }

    return jsonResponse({
      success: true,
      orderId: razorpayBody.id,
      amount: body.amountPaise,
      keyId: RAZORPAY_KEY_ID,
      donationId,
    });
  } catch (e) {
    console.error("razorpay-create-order error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
