// साझा Email helper — Resend (primary) + Brevo (overflow/backup), भाग 1.6 का फ़ैसला
// हर Edge Function जहाँ email भेजनी है, यहीं से `sendEmail()` बुलाएगा
//
// settings.ts-integrated (2026-09-24): API keys अब getSecret() से, from-address
// getSetting() से — GR के Admin Settings GUI से बदलने पर redeploy की ज़रूरत
// नहीं। Key names जान-बूझकर वही रखे गए हैं जिनसे getSecret/getSetting का अपना
// auto env-fallback (camelCase → SNAKE_CASE) पुराने env var names से मेल खाए
// (resendApiKey→RESEND_API_KEY, emailFrom→EMAIL_FROM, वग़ैरह) — इसलिए अगर GR ने
// पहले से Supabase Dashboard में ये secrets set कर रखे हैं, वो बिना किसी बदलाव
// के काम करते रहेंगे; GUI से set करना सिर्फ़ एक और (प्राथमिकता वाला) रास्ता है।

import { getSetting, getSecret } from "./settings.ts";

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
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
      }),
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
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
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

// Resend पहले कोशिश करेगा, fail होने पर Brevo — दोनों free-tier (भाग 1.6)
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const okResend = await sendViaResend(input);
  if (okResend) return true;
  console.warn("Resend failed/unavailable, falling back to Brevo:", input.to);
  return await sendViaBrevo(input);
}
