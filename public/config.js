// ============================================================================
// गहोई पोर्टल — config.js
//
// ⚠️ यह पूरे पोर्टल की इकलौती ऐसी file है जो सच में static/hardcoded रहेगी —
// बाक़ी हर configurable चीज़ (Cloudinary, Razorpay, Resend, branding, फ़ीस
// वगैरह) अब Admin Settings page (admin-settings.html) से चलती है और
// `app_settings`/`app_secrets` tables में रहती है, कोड में नहीं।
//
// Supabase URL + anon key यहाँ static रहने की वजह "chicken-and-egg" समस्या है:
// browser को Supabase से बात करने के लिए यही दो values चाहिए — इन्हें ख़ुद
// Supabase के database में रखकर पढ़ना मुमकिन नहीं (उसके लिए भी पहले यही दो
// values चाहिए होंगी)। इसलिए ये अकेली values हैं जो deploy के वक़्त सीधे यहाँ
// भरनी होंगी।
//
// SUPABASE_ANON_KEY यहाँ रखना पूरी तरह सुरक्षित है — यह एक publishable key है
// (Supabase की अपनी डॉक्यूमेंटेशन इसे browser में भेजने के लिए ही बनाती है),
// असली सुरक्षा RLS (Row Level Security) policies से आती है, इस key को छुपाने से
// नहीं। SERVICE_ROLE_KEY कभी भी यहाँ या किसी frontend file में नहीं आनी चाहिए —
// वो सिर्फ़ Supabase Dashboard → Edge Functions → Secrets में रहती है।
//
// GR: अपने Supabase project के Settings → API से ये दो values कॉपी करके यहाँ
// भरें (Project URL, और "anon" / "public" key — "service_role" key नहीं):
// ============================================================================

window.GP_CONFIG = {
  SUPABASE_URL: "https://uytcfbwmlkclhefyqowo.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5dGNmYndtbGtjbGhlZnlxb3dvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1NTYxMTMsImV4cCI6MjEwNTEzMjExM30.Z9DjAmt6ls5vbHzTe0t0xHr3A9vFfe5j9oSQZVUZjeU",
};
