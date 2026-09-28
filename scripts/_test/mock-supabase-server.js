#!/usr/bin/env node
// ============================================================================
// scripts/_test/mock-supabase-server.js
//
// create-auth-users.js को असल Supabase project के बिना, फिर भी असल HTTP-calls
// के ज़रिए टेस्ट करने के लिए — supabase-js जो endpoints/shapes इस्तेमाल करता है
// (PostgREST की persons table, Auth Admin API का /invite और /admin/users) उन्हें
// एक न्यूनतम रूप में यहाँ नक़ल किया गया है। कोई असली Supabase project अभी तक
// नहीं बना (Stage 1) — इसलिए create-auth-users.js की end-to-end verification
// इसी mock के ख़िलाफ़ हुई है, असल project के ख़िलाफ़ नहीं।
//
// इस्तेमाल:
//   node scripts/_test/mock-supabase-server.js &
//   SUPABASE_URL=http://localhost:8899 SUPABASE_SERVICE_ROLE_KEY=fake-key \
//     INVITE_DELAY_MS=50 node create-auth-users.js --execute --limit 10
//
// तीन scenario cover होते हैं: (1) साफ़ नया invite, (2) "already registered"
// email पर listUsers-fallback से relink, (3) auth_uid से filter करके सिर्फ़
// अभी तक ना-जुड़े members ही लौटते हैं।
// ============================================================================
const http = require("http");
const crypto = require("crypto");

const persons = [
  { gahoi_id: "GP00000001", name: "Ram Gupta", email: "ram@example.com", auth_uid: null },
  { gahoi_id: "GP00000002", name: "Shyam Verma", email: "shyam@example.com", auth_uid: null },
  { gahoi_id: "GP00000003", name: "Already Registered Guy", email: "dup@example.com", auth_uid: null },
];
const existingAuthUsers = [{ id: "existing-uuid-1234", email: "dup@example.com" }];

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/rest/v1/persons") {
      send(res, 200, persons.filter((p) => !p.auth_uid && p.email)
        .map((p) => ({ gahoi_id: p.gahoi_id, name: p.name, email: p.email })));
      return;
    }
    if (req.method === "PATCH" && path === "/rest/v1/persons") {
      const gahoiId = url.searchParams.get("gahoi_id").replace("eq.", "");
      const p = persons.find((x) => x.gahoi_id === gahoiId);
      if (p) Object.assign(p, JSON.parse(body || "{}"));
      send(res, 200, [p]);
      return;
    }
    if (req.method === "POST" && path === "/auth/v1/invite") {
      const payload = JSON.parse(body || "{}");
      if (payload.email === "dup@example.com") {
        send(res, 422, { msg: "A user with this email address has already been registered", error_code: "email_exists" });
        return;
      }
      send(res, 200, { user: { id: crypto.randomUUID(), email: payload.email, user_metadata: payload.data } });
      return;
    }
    if (req.method === "GET" && path === "/auth/v1/admin/users") {
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      send(res, 200, { users: page === 1 ? existingAuthUsers : [], aud: "x" });
      return;
    }
    send(res, 404, { error: "not found: " + path });
  });
});

server.listen(8899, () => console.log("mock Supabase server on :8899"));
