// ============================================================================
// akna-picker.js — अकना type-ahead (Hindi या English में type करें, सिर्फ़ मिलते-जुलते दिखें)
// config.js + common.js (gpSupabase) के बाद load करें।
//
// उपयोग:   const picker = gpAknaPicker({ input: "akna" });
//          picker.value()       -> input में जो है (चुना हुआ हो तो canonical Hindi नाम)
//          picker.recognized()  -> true अगर akna_list से चुना/पहचाना गया
//          picker.setValue(v)   -> पहले से भरा नाम दिखाओ (edit forms)
//
// Matching akna_list (Supabase) के hindi / english / variants से होती है; पूरी list एक बार
// खिंचती है (~220 पंक्तियाँ) और browser में filter होती है — हर key-press पर network नहीं।
// सुरक्षा-जाल: server (DB trigger canonical_akna) भी save के समय यही canonicalize करता है।
// ============================================================================
let _gpAknaCache = null;
async function gpLoadAknaList() {
  if (_gpAknaCache) return _gpAknaCache;
  const { data, error } = await gpSupabase.from("akna_list").select("hindi, english, variants").eq("active", true);
  _gpAknaCache = error || !data ? [] : data;
  return _gpAknaCache;
}

function gpNormAkna(s) { return String(s == null ? "" : s).replace(/[\u200b\u200c\u200d]/g, "").trim().toLowerCase().replace(/\s+/g, " "); }

// छोटी strings के लिए Levenshtein (code-points पर; Hindi भी चलेगा), limit पार होते ही रुक जाता है
function gpEditDistance(a, b, limit) {
  const x = Array.from(a), y = Array.from(b);
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]; let min = i;
    for (let j = 1; j <= y.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      cur.push(v); if (v < min) min = v;
    }
    if (min > limit) return limit + 1;
    prev = cur;
  }
  return prev[y.length];
}

// list: [{hindi, english, variants}], query: जो user ने लिखा  ->  [{hindi, english, score, fuzzy}] (सबसे अच्छे पहले)
function gpAknaMatch(list, query, limit) {
  const q = gpNormAkna(query);
  if (!q) return [];
  const max = limit || 8, out = [];
  for (const a of list) {
    const hindi = gpNormAkna(a.hindi);
    const tokens = [hindi, ...gpNormAkna(a.english).split(/[\s,;|]+/), ...gpNormAkna(a.variants).split(/[\s,;|]+/)].filter(Boolean);
    let best = 0, fuzzy = false;
    for (const t of tokens) {
      if (t === q) { best = 100; break; }
      if (t.startsWith(q)) best = Math.max(best, 80);
      else if (q.length >= 2 && t.includes(q)) best = Math.max(best, 60);
    }
    if (best === 0 && q.length >= 3) {          // टाइपिंग की ग़लती: ज़्यादा से ज़्यादा 1 (छोटे) / 2 (लंबे) अक्षर का फ़र्क़
      const lim = q.length <= 4 ? 1 : 2;
      for (const t of tokens) { const d = gpEditDistance(q, t, lim); if (d <= lim) { best = Math.max(best, 40 - d * 5); fuzzy = true; } }
    }
    if (best > 0) out.push({ hindi: a.hindi, english: (a.english || "").trim(), score: best, fuzzy });
  }
  out.sort((m, n) => n.score - m.score || String(m.hindi).localeCompare(String(n.hindi), "hi"));
  const seen = new Set();   // एक ही hindi दोबारा नहीं
  return out.filter((m) => (seen.has(m.hindi) ? false : (seen.add(m.hindi), true))).slice(0, max);
}

const GP_AKNA_CSS = `
.akna-wrap{position:relative}
.akna-pop{position:absolute;left:0;right:0;top:100%;z-index:50;background:var(--paper,#fff);border:1.5px solid var(--accent,#d4940a);border-radius:12px;box-shadow:var(--shadow-lg,0 8px 30px rgba(0,0,0,.18));margin-top:4px;max-height:280px;overflow-y:auto;display:none}
.akna-pop.open{display:block}
.akna-opt{padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;align-items:baseline;border-bottom:1px solid var(--border-soft,#eee)}
.akna-opt:last-child{border-bottom:none}
.akna-opt.active,.akna-opt:hover{background:var(--light,#faf3e3)}
.akna-opt b{color:var(--primary,#7a1f3d);font-size:1rem}
.akna-opt small{color:var(--muted,#888);font-size:.78rem}
.akna-opt em{font-style:normal;font-size:.7rem;color:var(--warning,#7a5c00);background:var(--warning-soft,#fff8e0);padding:1px 7px;border-radius:9px}
.akna-info{padding:10px 14px;font-size:.82rem;color:var(--muted,#777)}
.akna-status{font-size:.8rem;margin-top:5px;min-height:1.1em}
.akna-status.ok{color:var(--success,#2a6e48);font-weight:700}
.akna-status.warn{color:var(--warning,#7a5c00)}
`;
(function () { if (typeof document === "undefined") return; const s = document.createElement("style"); s.textContent = GP_AKNA_CSS; document.head.appendChild(s); })();

function gpAknaPicker(opts) {
  const input = typeof opts.input === "string" ? document.getElementById(opts.input) : opts.input;
  if (!input) return null;
  const wrap = document.createElement("div"); wrap.className = "akna-wrap";
  input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
  const pop = document.createElement("div"); pop.className = "akna-pop"; pop.setAttribute("role", "listbox"); wrap.appendChild(pop);
  const status = document.createElement("div"); status.className = "akna-status"; wrap.appendChild(status);
  input.setAttribute("autocomplete", "off"); input.setAttribute("aria-autocomplete", "list"); input.removeAttribute("list");

  let list = [], items = [], active = -1, ok = false;
  gpLoadAknaList().then((l) => { list = l; if (input.value && !ok) autoCanon(); });

  function setStatus(kind, text) { status.className = "akna-status " + (kind || ""); status.textContent = text || ""; }
  function close() { pop.classList.remove("open"); active = -1; }
  function choose(m) {
    input.value = m.hindi; ok = true; close();
    setStatus("ok", "✅ " + m.hindi + (m.english ? " (" + m.english.split(/\s+/)[0] + ")" : ""));
    if (opts.onChange) opts.onChange(m.hindi, true);
    input.dispatchEvent(new Event("akna-chosen", { bubbles: true }));
  }
  function render() {
    const q = input.value;
    items = gpAknaMatch(list, q, opts.max || 8);
    if (!gpNormAkna(q)) { close(); setStatus("", ""); return; }
    if (!items.length) {
      pop.innerHTML = '<div class="akna-info">इस नाम का अकना list में नहीं मिला। Hindi या English की दूसरी spelling आज़माएँ — या ऐसे ही रहने दें, Admin जाँच लेगा।</div>';
      pop.classList.add("open"); setStatus("warn", "⚠ list में नहीं मिला — जैसा लिखा है वैसा ही भेजा जाएगा"); return;
    }
    pop.innerHTML = items.map((m, i) => `<div class="akna-opt${i === active ? " active" : ""}" role="option" data-i="${i}"><span><b>${m.hindi}</b>${m.fuzzy ? " <em>शायद यह?</em>" : ""}</span><small>${(m.english || "").split(/\s+/)[0]}</small></div>`).join("");
    pop.classList.add("open");
    setStatus("", "");
  }
  // exact एक ही match हो तो blur पर अपने-आप canonical Hindi में बदल दो (user ने "reja" लिखा तो "रेजा")
  function autoCanon() {
    const ex = gpAknaMatch(list, input.value, 20).filter((m) => m.score === 100);
    if (ex.length === 1) choose(ex[0]);
  }

  input.addEventListener("input", () => { ok = false; active = -1; render(); if (opts.onChange) opts.onChange(input.value, false); });
  input.addEventListener("focus", () => { if (input.value && !ok) render(); });
  input.addEventListener("keydown", (e) => {
    if (!pop.classList.contains("open") || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === "Escape") { close(); }
  });
  pop.addEventListener("mousedown", (e) => { const o = e.target.closest(".akna-opt"); if (o) { e.preventDefault(); choose(items[+o.dataset.i]); } });
  input.addEventListener("blur", () => { setTimeout(() => { if (!ok) autoCanon(); close(); }, 120); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });

  return {
    value: () => input.value.trim(),
    recognized: () => ok,
    setValue(v) { input.value = v || ""; ok = false; if (v) { if (list.length) autoCanon(); } else setStatus("", ""); },
  };
}
