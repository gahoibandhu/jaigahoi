// ============================================================================
// SELF-CONTAINED बंडल्ड संस्करण — Supabase Dashboard "Via Editor" के लिए
// (multi-file _shared/ folder resolve नहीं हो रहा था, इसलिए सारा shared code
// यहीं inline है, कोई relative import नहीं)। Source of truth असली repo में
// supabase/functions/{name}/index.ts है — ये सिर्फ़ emergency deploy कॉपी है।
// ============================================================================

// ============================================================================
// Edge Function: matrimony-interest
//
// मौजूदा Code.gs के doMatInterest() से आगे बढ़कर — भाग 3 Phase F.1 का "Bidirectional
// Interest System" यहीं implement होता है। दो स्तर: Shortlist(private, कोई
// notification नहीं) और Interest(profile-owner को notify करता है)। दोनों तरफ़ से
// Interest हो जाए तो "Mutual Match" — Supabase Realtime से यही update फिर
// matrimony.html पर "live" दिखता है (कोई page-refresh नहीं चाहिए)।
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

// ── _shared/email.ts (inlined) ───────────────────────────────────────────
interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

async function sendViaResend(input: SendEmailInput): Promise<boolean> {
  const apiKey = await getSecret("resendApiKey");
  if (!apiKey) return false;
  try {
    const from = await getSetting<string>("emailConfig", "emailFrom", "Gahoi Portal <noreply@jaigahoi.in>");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html }),
    });
    return res.ok;
  } catch (e) {
    console.error("Resend send failed:", e);
    return false;
  }
}

async function sendViaBrevo(input: SendEmailInput): Promise<boolean> {
  const apiKey = await getSecret("brevoApiKey");
  if (!apiKey) return false;
  try {
    const fromAddress = await getSetting<string>("emailConfig", "emailFromAddress", "noreply@jaigahoi.in");
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { email: fromAddress, name: "Gahoi Portal" },
        to: [{ email: input.to }],
        subject: input.subject,
        htmlContent: input.html,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("Brevo send failed:", e);
    return false;
  }
}

async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const okResend = await sendViaResend(input);
  if (okResend) return true;
  console.warn("Resend failed/unavailable, falling back to Brevo:", input.to);
  return await sendViaBrevo(input);
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface InterestPayload {
  toProfileId: string;
  type: "shortlist" | "interest";
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflightRequest(req);
  if (preflight) return preflight;

  try {
    const PORTAL_URL = await getSetting<string>("publicConfig", "portalUrl", "") || Deno.env.get("PORTAL_URL") || "https://jaigahoi.in";
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
      .select("gahoi_id, name, mobile, city, address, status")
      .eq("auth_uid", userData.user.id)
      .maybeSingle();
    if (!requester || requester.status !== "Approved") {
      return jsonResponse({ success: false, message: "Access denied." }, 403);
    }

    const body: InterestPayload = await req.json();
    if (!body.toProfileId || !body.type) {
      return jsonResponse({ success: false, message: "toProfileId and type required." }, 400);
    }

    // ── Target profile — मौजूद है, approved है, और अपनी ही profile नहीं है ────
    const { data: toProfile } = await admin
      .from("matrimony_profiles")
      .select("id, created_by, name, status")
      .eq("id", body.toProfileId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!toProfile || toProfile.status !== "Approved") {
      return jsonResponse({ success: false, message: "Profile not found." }, 404);
    }
    if (toProfile.created_by === requester.gahoi_id) {
      return jsonResponse({ success: false, message: "अपनी ही profile में interest नहीं भेज सकते।" }, 400);
    }

    // ── Insert/Upsert (unique constraint from_gahoi_id+to_profile_id+type पहले से है) ──
    const { error: upsertErr } = await admin
      .from("matrimony_interests")
      .upsert(
        { from_gahoi_id: requester.gahoi_id, to_profile_id: body.toProfileId, type: body.type },
        { onConflict: "from_gahoi_id,to_profile_id,type", ignoreDuplicates: true },
      );
    if (upsertErr) return jsonResponse({ success: false, message: upsertErr.message }, 500);

    // Shortlist निजी है — कोई notification नहीं, यहीं रुक जाते हैं
    if (body.type === "shortlist") {
      return jsonResponse({ success: true, mutual: false });
    }

    // ── Mutual-match check — क्या requester की भी अपनी profile है, और उसमें
    //    profile-owner ने पहले से interest भेजा हुआ है? ─────────────────────────
    const { data: myProfile } = await admin
      .from("matrimony_profiles")
      .select("id")
      .eq("created_by", requester.gahoi_id)
      .is("deleted_at", null)
      .maybeSingle();

    let isMutual = false;
    if (myProfile) {
      const { data: reverseInterest } = await admin
        .from("matrimony_interests")
        .select("id")
        .eq("from_gahoi_id", toProfile.created_by)
        .eq("to_profile_id", myProfile.id)
        .eq("type", "interest")
        .maybeSingle();

      if (reverseInterest) {
        isMutual = true;
        // दोनों तरफ़ के records status='mutual' — यही update Supabase Realtime से
        // frontend पर बिना refresh के दिखेगा (postgres_changes subscription)
        await admin.from("matrimony_interests").update({ status: "mutual" })
          .eq("from_gahoi_id", requester.gahoi_id).eq("to_profile_id", body.toProfileId).eq("type", "interest");
        await admin.from("matrimony_interests").update({ status: "mutual" })
          .eq("id", reverseInterest.id);
      }
    }

    // ── Notification ─────────────────────────────────────────────────────────
    const { data: ownerPerson } = await admin
      .from("persons")
      .select("email, name")
      .eq("gahoi_id", toProfile.created_by)
      .maybeSingle();

    if (isMutual && ownerPerson?.email && requester) {
      // दोनों तरफ़ "It's a Match!" — अब contact details दोनों को भेजी जा सकती हैं
      const matchHtml = (otherName: string, otherMobile: string) => `
        <div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#7a1f3d">💑 यह एक Mutual Match है!</h2>
          <p><strong>${otherName}</strong> ने भी आपकी profile में interest दिखाया है।</p>
          <div style="background:#fff8e1;padding:14px;border-radius:8px;margin:14px 0">
            📞 Contact: ${otherMobile || "पोर्टल पर उपलब्ध"}
          </div>
          <p style="text-align:center"><a href="${PORTAL_URL}/matrimony.html" style="background:#7a1f3d;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none">Matrimony Section खोलें</a></p>
        </div>`;
      await sendEmail({ to: ownerPerson.email, subject: "💑 यह एक Match है! – Gahoi Portal", html: matchHtml(requester.name, requester.mobile) });
      // requester को भी भेजना है तो requester.email चाहिए होगा — persons select में जोड़ें अगर ज़रूरत हो
    } else if (ownerPerson?.email) {
      await sendEmail({
        to: ownerPerson.email,
        subject: `💑 New Matrimony Interest – ${requester.name} | Gahoi Portal`,
        html: `<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px">
          <h2>💑 New Interest!</h2>
          <p>आपकी matrimony profile में <strong>${requester.name}</strong> ने interest express किया है।</p>
          <p style="text-align:center"><a href="${PORTAL_URL}/matrimony.html" style="background:#7a1f3d;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none">Matrimony Section खोलें</a></p>
        </div>`,
      });
    }

    return jsonResponse({ success: true, mutual: isMutual });
  } catch (e) {
    console.error("matrimony-interest error:", e);
    return jsonResponse({ success: false, message: "Server error: " + (e as Error).message }, 500);
  }
});
