// ============================================================================
// supabase/functions/_shared/settings.ts
//
// किसी भी Edge Function को Cloudinary/Razorpay/Resend जैसी config चाहिए हो, तो
// सीधे Deno.env.get() की जगह यहाँ से पढ़ें — ताकि GR Admin Settings page से जो
// भी बदलें, वो बिना दोबारा deploy किए फ़ौरन असर करे।
//
// `settings` table (migration 0003, RLS 0012) doc_id/data jsonb shape में है:
//   publicConfig → portalName/portalUrl/cloudinaryCloudName/razorpayKeyId वगैरह
//   emailConfig  → resendFromEmail/resendFromName
//   appConfig    → mahasabhaFee/maxApprovers
//   secrets      → cloudinaryApiSecret/resendApiKey/razorpayKeySecret (service_role-only)
//
// Fallback क्रम हर key के लिए: पहले settings table की value (GUI से set की
// गई), ना मिले/खाली हो तो Deno.env.get(KEY) (Supabase Dashboard → Edge
// Functions → Secrets में manually set की गई value) — ताकि GR के GUI से
// configure करने से पहले भी functions टूटें नहीं।
//
// Cache: हर request पर बार-बार DB हिट ना करने के लिए 60-second in-memory cache।
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CACHE_TTL_MS = 60_000;

let docsCache: { data: Record<string, Record<string, unknown>>; at: number } | null = null;

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

async function loadDocs(): Promise<Record<string, Record<string, unknown>>> {
  if (docsCache && Date.now() - docsCache.at < CACHE_TTL_MS) return docsCache.data;
  const { data, error } = await adminClient().from("settings").select("doc_id, data");
  const map: Record<string, Record<string, unknown>> = {};
  if (!error && data) data.forEach((row) => { map[row.doc_id] = (row.data as Record<string, unknown>) || {}; });
  docsCache = { data: map, at: Date.now() };
  return map;
}

/** गैर-गुप्त setting पढ़ें — जैसे getSetting("publicConfig", "cloudinaryCloudName") */
export async function getSetting<T = unknown>(docId: string, key: string, fallback?: T): Promise<T> {
  const docs = await loadDocs();
  const doc = docs[docId] || {};
  if (key in doc && doc[key] !== "" && doc[key] !== null) return doc[key] as T;
  const envVal = Deno.env.get(key.replace(/([A-Z])/g, "_$1").toUpperCase());
  if (envVal !== undefined) return envVal as unknown as T;
  return fallback as T;
}

/** असली secret पढ़ें — settings.secrets doc (GUI से set) → env var → undefined */
export async function getSecret(key: string): Promise<string | undefined> {
  const docs = await loadDocs();
  const secrets = (docs["secrets"] || {}) as Record<string, string>;
  if (secrets[key]) return secrets[key];
  const envKey = key.replace(/([A-Z])/g, "_$1").toUpperCase();
  return Deno.env.get(envKey) || undefined;
}

/** Admin Settings page से update होने के फ़ौरन बाद उसी process में cache साफ़ करने के लिए */
export function clearSettingsCache() {
  docsCache = null;
}
