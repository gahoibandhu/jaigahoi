# Supabase Auth — Email Templates (OTP code ke liye zaroori)

Supabase ke default templates mein sirf **link** hoti hai. 6-ankon wala code tabhi aayega jab template mein `{{ .Token }}` ho.
Dashboard -> Authentication -> Email Templates. In **teeno** ko neeche wale se badlo (Subject bhi).

## 1) Confirm signup  (naye user ka Email Code)
Subject: `गहोई पोर्टल — आपका Verification Code`
```html
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px">
  <h2 style="color:#7a1f3d">🙏 गहोई पोर्टल में स्वागत है</h2>
  <p>आपका Verification Code:</p>
  <div style="font-size:30px;font-weight:800;letter-spacing:8px;text-align:center;padding:14px;background:#faf3e3;border-radius:10px">{{ .Token }}</div>
  <p>यह code थोड़ी देर में expire हो जाता है। किसी को न बताएँ।</p>
  <p style="font-size:13px;color:#777">या इस link से confirm करें: <a href="{{ .ConfirmationURL }}">Email Confirm करें</a></p>
</div>
```

## 2) Magic Link  (purane user ka Email-Code Login)
Subject: `गहोई पोर्टल — Login Code`
```html
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px">
  <h2 style="color:#7a1f3d">🔑 Login Code</h2>
  <div style="font-size:30px;font-weight:800;letter-spacing:8px;text-align:center;padding:14px;background:#faf3e3;border-radius:10px">{{ .Token }}</div>
  <p>यह code किसी को न बताएँ। आपने request नहीं की तो अनदेखा करें।</p>
  <p style="font-size:13px;color:#777">या सीधे login: <a href="{{ .ConfirmationURL }}">यहाँ click करें</a></p>
</div>
```

## 3) Reset Password
Subject: `गहोई पोर्टल — Password Reset`
```html
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px">
  <h2 style="color:#7a1f3d">🔒 Password Reset</h2>
  <p>नया password बनाने के लिए नीचे button दबाएँ:</p>
  <p style="text-align:center"><a href="{{ .ConfirmationURL }}" style="background:#d4940a;color:#3d0716;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:700">नया Password बनाएँ</a></p>
  <p style="font-size:13px;color:#777">आपने request नहीं की तो अनदेखा करें — आपका password सुरक्षित है।</p>
</div>
```

## Zaroori settings (warna OTP signup ruk jayega)
- **Custom SMTP (Resend)**: Project Settings -> Authentication -> SMTP. Supabase ka built-in email service ghante mein bahut kam mail bhejta hai.
- **Min password length = 8** (Providers -> Email).
- **OTP expiry**: Providers -> Email -> "Email OTP Expiration" (default 3600s; 600s behtar).
- **Redirect URLs**: `https://jaigahoi.in/auth-callback.html` aur `https://jaigahoi.in/forgot-password.html`.
- **Mobile OTP (baad mein)**: Providers -> Phone ON + SMS provider; India mein DLT registration; phir admin-auth.html mein toggle ON.
