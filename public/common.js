```javascript
// ============================================================================
// गहोई पोर्टल — common.js
// हर .html page यही file include करेगा
// ============================================================================

// ----------------------------------------------------------------------------
// Supabase configuration
// config.js MUST be loaded before common.js
// ----------------------------------------------------------------------------

const SUPABASE_URL = window.GP_CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.GP_CONFIG.SUPABASE_ANON_KEY;

// ----------------------------------------------------------------------------
// Supabase client
// Google OAuth के लिए PKCE flow use किया जा रहा है.
// ----------------------------------------------------------------------------

const gpSupabase = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      flowType: "pkce",
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  }
);

// ----------------------------------------------------------------------------
// Referral-link capture
// ----------------------------------------------------------------------------

(function captureReferral() {
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = (params.get("ref") || "").trim().toUpperCase();

    if (ref && !localStorage.getItem("gp_referrer_gahoi_id")) {
      localStorage.setItem("gp_referrer_gahoi_id", ref);
    }
  } catch (e) {
    // localStorage unavailable होने पर silently skip
  }
})();

// ----------------------------------------------------------------------------
// Public settings
// ----------------------------------------------------------------------------

let _gpPublicConfigCache = null;

async function gpGetPublicConfig() {
  if (_gpPublicConfigCache) {
    return _gpPublicConfigCache;
  }

  const { data, error } = await gpSupabase
    .from("settings")
    .select("data")
    .eq("doc_id", "publicConfig")
    .maybeSingle();

  _gpPublicConfigCache =
    (!error && data && data.data)
      ? data.data
      : {};

  return _gpPublicConfigCache;
}

async function gpGetPublicSetting(key, fallback) {
  const config = await gpGetPublicConfig();

  if (
    Object.prototype.hasOwnProperty.call(config, key) &&
    config[key] !== ""
  ) {
    return config[key];
  }

  return fallback;
}

// ----------------------------------------------------------------------------
// Generic settings document helper
// ----------------------------------------------------------------------------

const _gpSettingsDocCache = {};

async function gpGetSettingsDoc(docId) {
  if (_gpSettingsDocCache[docId]) {
    return _gpSettingsDocCache[docId];
  }

  const { data, error } = await gpSupabase
    .from("settings")
    .select("data")
    .eq("doc_id", docId)
    .maybeSingle();

  const result =
    (!error && data && data.data)
      ? data.data
      : {};

  _gpSettingsDocCache[docId] = result;

  return result;
}

async function gpGetSetting(docId, key, fallback) {
  const doc = await gpGetSettingsDoc(docId);

  if (
    Object.prototype.hasOwnProperty.call(doc, key) &&
    doc[key] !== "" &&
    doc[key] !== null
  ) {
    return doc[key];
  }

  return fallback;
}

// ----------------------------------------------------------------------------
// Auth guard
// ----------------------------------------------------------------------------

async function gpRequireLogin(redirectTo = "login.html") {
  const {
    data: { session },
    error
  } = await gpSupabase.auth.getSession();

  if (error) {
    console.error("gpRequireLogin session error:", error);
  }

  if (!session) {
    window.location.href = redirectTo;
    return null;
  }

  return session;
}

// ----------------------------------------------------------------------------
// Current user's profile
// ----------------------------------------------------------------------------

async function gpGetMyProfile() {
  const {
    data: { session },
    error: sessionError
  } = await gpSupabase.auth.getSession();

  if (sessionError) {
    console.error(
      "gpGetMyProfile session error:",
      sessionError
    );
    return null;
  }

  if (!session) {
    return null;
  }

  const {
    data,
    error
  } = await gpSupabase
    .from("persons")
    .select("*")
    .eq("auth_uid", session.user.id)
    .maybeSingle();

  if (error) {
    console.error(
      "gpGetMyProfile error:",
      error
    );
    return null;
  }

  return data;
}

// ----------------------------------------------------------------------------
// Edge Function helper
// ----------------------------------------------------------------------------

async function gpCallFunction(functionName, payload) {
  const {
    data: { session },
    error: sessionError
  } = await gpSupabase.auth.getSession();

  if (sessionError) {
    console.error(
      "gpCallFunction session error:",
      sessionError
    );
  }

  const headers = {};

  if (session && session.access_token) {
    headers.Authorization =
      "Bearer " + session.access_token;
  }

  const {
    data,
    error
  } = await gpSupabase.functions.invoke(
    functionName,
    {
      body: payload,
      headers: headers
    }
  );

  if (error) {
    console.error(
      "gpCallFunction error:",
      error
    );

    return {
      success: false,
      message:
        error.message ||
        "Request failed."
    };
  }

  return data;
}

// ----------------------------------------------------------------------------
// Cloudinary — unsigned upload helper
// ----------------------------------------------------------------------------

async function gpUploadToCloudinary(
  file,
  folder = "gahoi-portal"
) {
  const cloudName = await gpGetSetting(
    "publicConfig",
    "cloudinaryCloudName",
    ""
  );

  const uploadPreset = await gpGetSetting(
    "publicConfig",
    "cloudinaryUploadPreset",
    ""
  );

  if (!cloudName || !uploadPreset) {
    return {
      success: false,
      message:
        "Cloudinary अभी configure नहीं है — Admin को Settings में Cloud Name/Upload Preset भरने दें।"
    };
  }

  if (
    !file ||
    !file.type ||
    !file.type.startsWith("image/")
  ) {
    return {
      success: false,
      message:
        "कृपया एक image file चुनें।"
    };
  }

  if (file.size > 5 * 1024 * 1024) {
    return {
      success: false,
      message:
        "Image 5MB से बड़ी नहीं होनी चाहिए।"
    };
  }

  const formData = new FormData();

  formData.append(
    "file",
    file
  );

  formData.append(
    "upload_preset",
    uploadPreset
  );

  formData.append(
    "folder",
    folder
  );

  try {
    const res = await fetch(
      "https://api.cloudinary.com/v1_1/" +
      cloudName +
      "/image/upload",
      {
        method: "POST",
        body: formData
      }
    );

    const data = await res.json();

    if (!res.ok || !data.secure_url) {
      return {
        success: false,
        message:
          (
            data.error &&
            data.error.message
          ) ||
          "Upload असफल रहा।"
      };
    }

    return {
      success: true,
      url: data.secure_url
    };

  } catch (e) {
    return {
      success: false,
      message:
        "Upload नहीं हो सका: " +
        e.message
    };
  }
}

// ----------------------------------------------------------------------------
// Alert helpers
// ----------------------------------------------------------------------------

function gpShowAlert(
  elId,
  message,
  type = "error"
) {
  const el =
    document.getElementById(elId);

  if (!el) {
    console.warn(
      "gpShowAlert: element not found:",
      elId
    );
    return;
  }

  el.className =
    "gp-alert gp-alert-" + type;

  el.textContent = message;

  el.style.display = "block";
}

function gpHideAlert(elId) {
  const el =
    document.getElementById(elId);

  if (el) {
    el.style.display = "none";
  }
}

// ----------------------------------------------------------------------------
// Feature flags
// ----------------------------------------------------------------------------

async function gpIsFeatureEnabled(
  flagKey,
  fallback = true
) {
  return await gpGetSetting(
    "featureFlags",
    flagKey,
    fallback
  );
}

async function gpGuardFeature(
  flagKey,
  featureLabelHindi
) {
  const enabled =
    await gpIsFeatureEnabled(
      flagKey,
      true
    );

  if (enabled) {
    return true;
  }

  const customMsg =
    await gpGetSetting(
      "featureFlags",
      "portalMaintenanceMessage",
      ""
    );

  window.alert(
    customMsg &&
    customMsg.trim()
      ? customMsg
      : "⚠️ \"" +
        featureLabelHindi +
        "\" फ़िलहाल Admin द्वारा बंद किया गया है। कृपया बाद में कोशिश करें।"
  );

  window.location.href =
    "home.html";

  return false;
}
```
