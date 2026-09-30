// साझा CORS headers — हर Edge Function इसे इस्तेमाल करेगा
// (Supabase का standard पैटर्न — अलग-अलग function में दोहराना नहीं)
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",   // Production में इसे jaigahoi.in तक सीमित करना बेहतर होगा
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function handleCorsPreflightRequest(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
