// ============================================================================
//  GAHOI PORTAL — Panchang + Festivals cron (Apps Script -> Supabase)
//  Doc ke faisle ke mutabik GAS sirf low-frequency cron ke liye rehta hai.
//  Ye ek ALAG, chhota Apps Script project hai (purane Code.gs se alag) —
//  isliye naam clash nahi hoga. Purana Code.gs ka Panchang/Festival hissa
//  is project mein copy nahi hua; parsing code verbatim wahi hai.
//
//  SETUP (ek baar):
//   1. Project Settings -> Script properties:
//        SUPABASE_URL          = https://xxxx.supabase.co
//        SUPABASE_SERVICE_KEY  = <service_role key>   (secret, kabhi frontend mein nahi)
//   2. setupPanchangFestivalTriggers() ek baar Run karo.
//   3. Pehle test: testPanchangOnce() aur testFestivalsOnce() Run karo,
//      phir Supabase Table Editor mein panchang_daily / festivals dekho.
//  Deploy kuch nahi karna (web app nahi hai). Code badle to "New version".
// ============================================================================

function _sb_(path, method, payload, prefer) {
  var props = PropertiesService.getScriptProperties();
  var base = props.getProperty('SUPABASE_URL');
  var key  = props.getProperty('SUPABASE_SERVICE_KEY');
  if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY Script Properties mein set karo.');
  var headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (prefer) headers.Prefer = prefer;
  var res = UrlFetchApp.fetch(base.replace(/\/$/, '') + '/rest/v1/' + path, {
    method: method || 'get',
    contentType: 'application/json',
    headers: headers,
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Supabase ' + code + ': ' + res.getContentText());
  return res.getContentText();
}

// dd/MM/yyyy -> yyyy-MM-dd
function _isoFromDDMMYYYY_(s) {
  var p = String(s).split('/');
  return p[2] + '-' + p[1] + '-' + p[0];
}

// ───────── Daily Panchang -> panchang_daily ─────────
function dailyPanchangFetch() {
  var dateStr = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy');
  var p = fetchDrikPanchang_(dateStr);
  if (!p || (!p.tithi && !p.nakshatra && !p.yoga)) {
    Logger.log('Panchang parse khali raha — Supabase mein kuch nahi likha: ' + dateStr);
    return false;
  }
  var row = {
    date: _isoFromDDMMYYYY_(p.date),
    tithi: p.tithi, nakshatra: p.nakshatra, yoga: p.yoga, karana: p.karana,
    paksha: p.paksha, amanta: p.amanta, purnimanta: p.purnimanta, samvat: p.samvat,
    sunrise: p.sunrise, sunset: p.sunset, festival: p.festival || '',
    fetched_at: new Date().toISOString()
  };
  _sb_('panchang_daily?on_conflict=date', 'post', [row], 'resolution=merge-duplicates,return=minimal');
  Logger.log('Panchang saved: ' + row.date + ' | ' + row.tithi);
  return true;
}

// ───────── Festivals -> festivals ─────────
function refreshFestivals() {
  var year = new Date().getFullYear();
  var events = fetchDrikMonthFestivals_(year);
  if (new Date().getMonth() >= 9) events = events.concat(fetchDrikMonthFestivals_(year + 1));
  if (!events.length) { Logger.log('Koi festival parse nahi hua — kuch nahi likha.'); return 0; }

  var now = new Date().toISOString();
  var rows = events.map(function (e) {
    return { date: e.date, name: e.name, hindi: e.hindi, emoji: e.emoji, category: 'Hindu', fetched_at: now };
  });
  // 200-200 ke batch (Supabase request size safe rakhne ke liye)
  for (var i = 0; i < rows.length; i += 200) {
    _sb_('festivals?on_conflict=date,name', 'post', rows.slice(i, i + 200), 'resolution=merge-duplicates,return=minimal');
  }
  Logger.log('Festivals saved: ' + rows.length);
  return rows.length;
}

// ───────── Triggers ─────────
function setupPanchangFestivalTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'dailyPanchangFetch' || f === 'refreshFestivals') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyPanchangFetch').timeBased().atHour(6).everyDays(1).inTimezone('Asia/Kolkata').create();
  ScriptApp.newTrigger('refreshFestivals').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(5).inTimezone('Asia/Kolkata').create();
  dailyPanchangFetch();
  refreshFestivals();
  Logger.log('Triggers set: daily 6am Panchang, weekly Monday 5am Festivals');
}

function testPanchangOnce()  { Logger.log('Result: ' + dailyPanchangFetch()); }
function testFestivalsOnce() { Logger.log('Saved rows: ' + refreshFestivals()); }

// ============================================================================
//  NEECHE: legacy Code.gs se verbatim parsing code (Drik Panchang scraping)
// ============================================================================

const TITHIS = ['Pratipada','Dwitiya','Tritiya','Chaturthi','Panchami','Shashthi','Saptami',
                'Ashtami','Navami','Dashami','Ekadashi','Dwadashi','Trayodashi','Chaturdashi',
                'Purnima','Amavasya'];
const NAKSHATRAS = ['Ashwini','Bharani','Krittika','Rohini','Mrigashira','Mrigashirsha','Ardra','Punarvasu',
                    'Pushya','Ashlesha','Magha','Purva Phalguni','Uttara Phalguni','Hasta',
                    'Chitra','Swati','Vishakha','Anuradha','Jyeshtha','Mula','Purva Ashadha',
                    'Uttara Ashadha','Shravana','Dhanishta','Dhanishtha','Shatabhisha','Shatabhishak',
                    'Purva Bhadrapada','Uttara Bhadrapada','Revati'];
const YOGAS = ['Vishkambha','Preeti','Ayushman','Saubhagya','Shobhana','Atiganda','Sukarma',
               'Dhriti','Shoola','Ganda','Vriddhi','Dhruva','Vyaghata','Harshana','Vajra',
               'Siddhi','Vyatipata','Variyana','Parigha','Shiva','Siddha','Sadhya','Shubha',
               'Shukla','Brahma','Indra','Vaidhriti'];
const KARANAS = ['Bava','Balava','Kaulava','Taitila','Garaja','Vanija','Vishti',
                 'Shakuni','Chatushpada','Naga','Kintughna','Kimstughna'];
const MONTHS = ['Chaitra','Vaishakha','Jyeshtha','Ashadha','Shravana','Bhadrapada',
                'Ashwin','Ashwina','Ashvina','Kartika','Kartik','Margashirsha','Pausha','Magha','Phalguna'];
// NOTE: Drik ab "Ashwina" likhta hai ("Chandramasa Ashwina - Purnimanta"). Purani list mein
// sirf "Ashwin" tha, isliye purnimanta khali aa raha tha — spelling variants add kiye.

function stripHtml_(html){
  html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  html = html.replace(/<!--[\s\S]*?-->/g, ' ');
  html = html.replace(/<meta[^>]*>/gi, ' ');
  html = html.replace(/<link[^>]*>/gi, ' ');
  html = html.replace(/<[^>]+>/g, ' ');
  // Decode entities but KEEP &#9432; (ⓘ) as marker temporarily
  html = html.replace(/&#9432;/g, '|MARKER|');
  html = html.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  html = html.replace(/&#x[0-9a-fA-F]+;/g, '');
  html = html.replace(/\s+/g, ' ').trim();
  return html;
}

// Find a value from candidates that occurs as a standalone proper noun
// (preceded and followed by spaces or punctuation, not part of longer word)
function findStandaloneMatch_(text, candidates, fromPos){
  fromPos = fromPos || 0;
  let earliestPos = -1;
  let matched = '';
  for(let c of candidates){
    // Look for whole-word match
    const re = new RegExp('(?:^|[\\s\\|>])(' + c.replace(/\s/g, '\\s+') + ')(?=[\\s\\|<,]|upto|$)', 'g');
    re.lastIndex = fromPos;
    const m = re.exec(text);
    if(m && (earliestPos < 0 || m.index < earliestPos)){
      earliestPos = m.index + m[0].indexOf(c[0]);
      matched = c;
    }
  }
  return { value: matched, pos: earliestPos };
}

function fetchDrikPanchang_(dateStr){
  if(!dateStr){
    dateStr = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy');
  }
  
  const url = 'https://www.drikpanchang.com/panchang/day-panchang.html?date=' + dateStr + '&geoname-id=1273294';
  Logger.log('Fetching: ' + url);
  
  let html = '';
  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    html = resp.getContentText();
    Logger.log('HTTP ' + resp.getResponseCode() + ', HTML length: ' + html.length);
  } catch(e){
    Logger.log('Fetch error: ' + e.message);
    return null;
  }
  
  if(!html || html.length < 5000) return null;
  
  const text = stripHtml_(html);
  Logger.log('Stripped text length: ' + text.length);
  Logger.log('Markers (|MARKER|) found: ' + (text.match(/\|MARKER\|/g) || []).length);
  
  // CRITICAL: Find first |MARKER| which is unique to panchang data section
  const firstMarker = text.indexOf('|MARKER|');
  Logger.log('First marker position: ' + firstMarker);
  
  if(firstMarker < 0){
    Logger.log('No |MARKER| found - HTML structure changed');
    Logger.log('First 2000 chars: ' + text.substring(0, 2000));
    return null;
  }
  
  // Panchang data starts BEFORE first marker. Go back ~500 chars to capture Tithi
  // and extend forward to capture all fields (Tithi, Nakshatra, Yoga, Karana, Paksha, Months, etc)
  const blockStart = Math.max(0, firstMarker - 500);
  const blockEnd = Math.min(text.length, firstMarker + 4000);
  let panchangBlock = text.substring(blockStart, blockEnd);
  
  Logger.log('=== PANCHANG BLOCK (' + panchangBlock.length + ' chars) ===');
  Logger.log(panchangBlock);
  Logger.log('=== END BLOCK ===');
  
  // Now within panchangBlock, find each field's value
  // The order in Drik is typically:
  // Tithi → Nakshatra → Yoga → Karana → Paksha → Weekday → Amanta Month → Purnimanta Month
  // Each ends with "upto TIME" then |MARKER|, except Paksha (which has no upto)
  
  // Helper: extract "NAME upto TIME" stopping precisely at next field
  function extractByValue(candidates, label){
    const match = findStandaloneMatch_(panchangBlock, candidates);
    if(match.pos < 0) return '';
    
    // Take from match position till next |MARKER| or 120 chars
    let endPos = panchangBlock.indexOf('|MARKER|', match.pos);
    if(endPos < 0 || endPos - match.pos > 150) endPos = match.pos + 150;
    
    let value = panchangBlock.substring(match.pos, endPos).trim();
    value = value.replace(/\|MARKER\|/g, '').trim();
    
    // KEY FIX: After "upto TIME PM" or "upto TIME AM", stop
    // Pattern: "NAME upto HH:MM AM/PM" or "NAME upto HH:MM AM/PM , DATE"
    const uptoMatch = value.match(/^(.+?upto\s+\d{1,2}:\d{2}\s*[AP]M(?:\s*,\s*[A-Z][a-z]+\s*\d{1,2})?)/i);
    if(uptoMatch){
      return uptoMatch[1].trim();
    }
    
    // If no "upto" pattern (some fields don't have time), stop at next proper noun or label
    const stoppers = ['Tithi','Nakshatra','Yoga','Karana','Paksha','Weekday','Amanta','Purnimanta',
                      'Moonsign','Sunsign','Pravishte','Shaka','Vikram','Gujarati','Sunrise','Sunset',
                      'Moonrise','Moonset','Festival','Vrat','Hindu','Anandadi','Auspicious',
                      'Inauspicious','Rahu','Yama','Abhijit','Choghadiya','Ekadashi','Lunar',
                      'Chandramasa','Mantri','Rashi','Ritu'];
    for(let s of stoppers){
      if(s === label) continue;
      const sp = value.indexOf(s, match.value.length);
      if(sp > 0) value = value.substring(0, sp).trim();
    }
    return value.trim();
  }
  
  // Time extraction with simple regex
  function extractTime(label){
    const re = new RegExp(label + '[\\s:]*([0-9]{1,2}:[0-9]{2}\\s*[AP]M)', 'i');
    const m = panchangBlock.match(re);
    return m ? m[1].trim() : '';
  }
  
  function extractPaksha(){
    if(panchangBlock.indexOf('Krishna Paksha') >= 0) return 'Krishna Paksha';
    if(panchangBlock.indexOf('Shukla Paksha') >= 0) return 'Shukla Paksha';
    return '';
  }
  
  // For Amanta/Purnimanta - Drik uses TWO formats:
  // Format A: "Amanta Month: Vaishakha" (older)
  // Format B: "Chandramasa Jyeshtha - Purnimanta" or "Vaishakha - Amanta" (newer)
  function extractMonth(label){
    // Format B FIRST (current Drik format)
    let re = new RegExp('([A-Z][a-z]+)\\s*-\\s*' + label, 'i');
    let m = panchangBlock.match(re);
    if(m && MONTHS.indexOf(m[1]) >= 0) return m[1];
    
    // Format A as fallback
    re = new RegExp(label + '\\s+Month[\\s:]+([A-Z][a-z]+)', 'i');
    m = panchangBlock.match(re);
    if(m && MONTHS.indexOf(m[1]) >= 0) return m[1];
    
    re = new RegExp(label + '[\\s:]+([A-Z][a-z]+)', 'i');
    m = panchangBlock.match(re);
    if(m && MONTHS.indexOf(m[1]) >= 0) return m[1];
    
    return '';
  }
  
  function extractSamvat(){
    const m = panchangBlock.match(/Vikram\s+Samvat[\s:]*([0-9]{4})(?:\s+([A-Z][a-z]+))?/i);
    if(m) return m[1] + (m[2] ? ' ' + m[2] : '');
    return '';
  }
  
  const result = {
    date: dateStr,
    tithi: extractByValue(TITHIS, 'Tithi'),
    nakshatra: extractByValue(NAKSHATRAS, 'Nakshatra'),
    yoga: extractByValue(YOGAS, 'Yoga'),
    karana: extractByValue(KARANAS, 'Karana'),
    paksha: extractPaksha(),
    amanta: extractMonth('Amanta'),
    purnimanta: extractMonth('Purnimanta'),
    samvat: extractSamvat(),
    sunrise: extractTime('Sunrise'),
    sunset: extractTime('Sunset'),
    festival: '',
    fetchedAt: new Date().toISOString()
  };
  
  Logger.log('Parsed values:');
  Logger.log(JSON.stringify(result, null, 2));
  
  return result;
}


const FESTIVAL_HINDI = {
  'Holi': 'होली', 'Holika Dahan': 'होलिका दहन', 'Chhoti Holi': 'छोटी होली',
  'Diwali': 'दीवाली', 'Deepavali': 'दीवाली', 'Dhanteras': 'धनतेरस',
  'Naraka Chaturdashi': 'नरक चतुर्दशी', 'Lakshmi Puja': 'लक्ष्मी पूजा',
  'Govardhan Puja': 'गोवर्धन पूजा', 'Bhai Dooj': 'भाई दूज', 'Bhaiya Dooj': 'भैया दूज',
  'Dussehra': 'दशहरा', 'Dasara': 'दशहरा', 'Vijayadashami': 'विजयदशमी',
  'Raksha Bandhan': 'रक्षाबंधन',
  'Janmashtami': 'जन्माष्टमी', 'Krishna Janmashtami': 'कृष्ण जन्माष्टमी',
  'Ganesh Chaturthi': 'गणेश चतुर्थी', 'Ganesha Chaturthi': 'गणेश चतुर्थी',
  'Anant Chaturdashi': 'अनंत चतुर्दशी', 'Anant Chaturdashi Vrat': 'अनंत चतुर्दशी',
  'Navaratri': 'नवरात्रि', 'Navratri': 'नवरात्रि',
  'Sharad Navratri': 'शारदीय नवरात्रि', 'Shardiya Navratri': 'शारदीय नवरात्रि',
  'Chaitra Navratri': 'चैत्र नवरात्रि',
  'Maha Shivaratri': 'महाशिवरात्रि', 'Mahashivratri': 'महाशिवरात्रि',
  'Masik Shivaratri': 'मासिक शिवरात्रि',
  'Karva Chauth': 'करवा चौथ', 'Karwa Chauth': 'करवा चौथ',
  'Karaka Chaturthi': 'करक चतुर्थी', 'Sankashti Chaturthi': 'संकष्टी चतुर्थी',
  'Ram Navami': 'राम नवमी', 'Hanuman Jayanti': 'हनुमान जयंती',
  'Guru Purnima': 'गुरु पूर्णिमा', 'Buddha Purnima': 'बुद्ध पूर्णिमा',
  'Vaisakhi': 'वैशाखी', 'Baisakhi': 'बैसाखी',
  'Makar Sankranti': 'मकर संक्रांति', 'Mesha Sankranti': 'मेष संक्रांति',
  'Pongal': 'पोंगल', 'Thai Pongal': 'पोंगल', 'Lohri': 'लोहड़ी',
  'Onam': 'ओणम', 'Vasant Panchami': 'वसंत पंचमी', 'Basant Panchami': 'बसंत पंचमी',
  'Mahalaya': 'महालया', 'Pitru Paksha': 'पितृ पक्ष',
  'Durga Puja': 'दुर्गा पूजा', 'Durga Ashtami': 'दुर्गा अष्टमी', 'Maha Ashtami': 'महा अष्टमी',
  'Maha Navami': 'महा नवमी',
  
  // Ekadashis (all 24+)
  'Ekadashi': 'एकादशी',
  'Nirjala Ekadashi': 'निर्जला एकादशी',
  'Devshayani Ekadashi': 'देवशयनी एकादशी', 'Devuthani Ekadashi': 'देवउठनी एकादशी',
  'Devshani Ekadashi': 'देवशयनी एकादशी',
  'Yogini Ekadashi': 'योगिनी एकादशी',
  'Kamika Ekadashi': 'कामिका एकादशी',
  'Putrada Ekadashi': 'पुत्रदा एकादशी', 'Pavitra Ekadashi': 'पवित्रा एकादशी',
  'Aja Ekadashi': 'अजा एकादशी',
  'Parivartini Ekadashi': 'परिवर्तिनी एकादशी', 'Parsva Ekadashi': 'पार्श्व एकादशी',
  'Indira Ekadashi': 'इंदिरा एकादशी',
  'Papankusha Ekadashi': 'पापांकुशा एकादशी',
  'Rama Ekadashi': 'रमा एकादशी', 'Devuthana Ekadashi': 'देवउठनी एकादशी',
  'Utpanna Ekadashi': 'उत्पन्ना एकादशी', 'Mokshada Ekadashi': 'मोक्षदा एकादशी',
  'Saphala Ekadashi': 'सफला एकादशी', 'Pausha Putrada Ekadashi': 'पौष पुत्रदा एकादशी',
  'Shattila Ekadashi': 'षटतिला एकादशी', 'Jaya Ekadashi': 'जया एकादशी',
  'Vijaya Ekadashi': 'विजया एकादशी', 'Amalaki Ekadashi': 'आमलकी एकादशी',
  'Papamochani Ekadashi': 'पापमोचनी एकादशी', 'Kamada Ekadashi': 'कामदा एकादशी',
  'Varuthini Ekadashi': 'वरूथिनी एकादशी', 'Mohini Ekadashi': 'मोहिनी एकादशी',
  'Apara Ekadashi': 'अपरा एकादशी',
  
  // Purnimas
  'Purnima': 'पूर्णिमा',
  'Vaishakha Purnima': 'वैशाख पूर्णिमा', 'Jyeshtha Purnima': 'ज्येष्ठ पूर्णिमा',
  'Ashadha Purnima': 'आषाढ़ पूर्णिमा', 'Shravana Purnima': 'श्रावण पूर्णिमा',
  'Bhadrapada Purnima': 'भाद्रपद पूर्णिमा', 'Ashwina Purnima': 'अश्विन पूर्णिमा',
  'Kartik Purnima': 'कार्तिक पूर्णिमा', 'Margashirsha Purnima': 'मार्गशीर्ष पूर्णिमा',
  'Pausha Purnima': 'पौष पूर्णिमा', 'Magha Purnima': 'माघ पूर्णिमा',
  'Phalguna Purnima': 'फाल्गुन पूर्णिमा', 'Sharad Purnima': 'शरद पूर्णिमा',
  'Chaitra Purnima': 'चैत्र पूर्णिमा',
  
  // Additional festivals  
  'Sakat Chauth': 'सकट चौथ', 'Ganesh Chauth': 'गणेश चौथ',
  'Makara Sankranti': 'मकर संक्रांति',
  'Ratha Saptami': 'रथ सप्तमी', 'Rath Saptami': 'रथ सप्तमी',
  'Bhishma Ashtami': 'भीष्म अष्टमी',
  'Mauni Amavas': 'मौनी अमावस्या', 'Mauni Amavasya': 'मौनी अमावस्या',
  'Surya Grahan': 'सूर्य ग्रहण', 'Chandra Grahan': 'चंद्र ग्रहण',
  'Sheetala Ashtami': 'शीतला अष्टमी', 'Basoda': 'बसौड़ा',
  'Nutan Varsh Prarambha': 'नूतन वर्ष आरंभ',
  'Gauri Puja': 'गौरी पूजा', 'Gangaur': 'गणगौर',
  'Yamuna Chhath': 'यमुना छठ',
  'Rama Navami': 'राम नवमी', 'Ram Navami': 'राम नवमी',
  'Swaminarayan Jayanti': 'स्वामीनारायण जयंती',
  'Padmini Ekadashi': 'पद्मिनी एकादशी',
  'Parama Ekadashi': 'परम एकादशी', 'Param Ekadashi': 'परम एकादशी',
  'Apara Ekadashi': 'अपरा एकादशी',
  'Vat Savitri Vrat': 'वट सावित्री व्रत', 'Vat Savitri': 'वट सावित्री',
  'Vat Purnima Vrat': 'वट पूर्णिमा व्रत', 'Vat Purnima': 'वट पूर्णिमा',
  'Adhika Purnima': 'अधिक पूर्णिमा',
  'Sheetala Saptami': 'शीतला सप्तमी',
  'Papamochani Ekadashi': 'पापमोचनी एकादशी',
  'Saphala Ekadashi': 'सफला एकादशी',
  'Putrada Ekadashi': 'पुत्रदा एकादशी',
  'Shattila Ekadashi': 'षट्तिला एकादशी',
  'Jaya Ekadashi': 'जया एकादशी',
  'Vijaya Ekadashi': 'विजया एकादशी',
  'Amalaki Ekadashi': 'आमलकी एकादशी',
  'Kamada Ekadashi': 'कामदा एकादशी',
  'Varuthini Ekadashi': 'वरूथिनी एकादशी',
  'Mohini Ekadashi': 'मोहिनी एकादशी',
  'Nirjala Ekadashi': 'निर्जला एकादशी',
  'Yogini Ekadashi': 'योगिनी एकादशी',
  'Devshayani Ekadashi': 'देवशयनी एकादशी',
  'Kamika Ekadashi': 'कामिका एकादशी',
  'Pavitra Ekadashi': 'पवित्रा एकादशी',
  'Aja Ekadashi': 'अजा एकादशी',
  'Parivartini Ekadashi': 'परिवर्तिनी एकादशी',
  'Indira Ekadashi': 'इंदिरा एकादशी',
  'Papankusha Ekadashi': 'पापांकुशा एकादशी',
  'Rama Ekadashi': 'रमा एकादशी',
  'Utpanna Ekadashi': 'उत्पन्ना एकादशी',
  'Mokshada Ekadashi': 'मोक्षदा एकादशी',
  'Devuthana Ekadashi': 'देवउठनी एकादशी', 'Devotthana Ekadashi': 'देवउठनी एकादशी',
  
  // Gauna (alternate observance) Ekadashis - Hindi
  'Gauna Yogini Ekadashi': 'गौण योगिनी एकादशी',
  'Gauna Devshayani Ekadashi': 'गौण देवशयनी एकादशी',
  'Gauna Kamika Ekadashi': 'गौण कामिका एकादशी',
  'Gauna Putrada Ekadashi': 'गौण पुत्रदा एकादशी',
  'Gauna Aja Ekadashi': 'गौण अजा एकादशी',
  'Gauna Parsva Ekadashi': 'गौण पार्श्व एकादशी',
  'Gauna Parivartini Ekadashi': 'गौण परिवर्तिनी एकादशी',
  'Gauna Indira Ekadashi': 'गौण इंदिरा एकादशी',
  'Gauna Papankusha Ekadashi': 'गौण पापांकुशा एकादशी',
  'Gauna Rama Ekadashi': 'गौण रमा एकादशी',
  'Gauna Devuthana Ekadashi': 'गौण देवउठनी एकादशी',
  'Gauna Utpanna Ekadashi': 'गौण उत्पन्ना एकादशी',
  'Gauna Mokshada Ekadashi': 'गौण मोक्षदा एकादशी',
  'Gauna Saphala Ekadashi': 'गौण सफला एकादशी',
  'Gauna Putrada Ekadashi Pausha': 'गौण पुत्रदा एकादशी',
  'Gauna Shattila Ekadashi': 'गौण षट्तिला एकादशी',
  'Gauna Jaya Ekadashi': 'गौण जया एकादशी',
  'Gauna Vijaya Ekadashi': 'गौण विजया एकादशी',
  'Gauna Amalaki Ekadashi': 'गौण आमलकी एकादशी',
  'Gauna Papamochani Ekadashi': 'गौण पापमोचनी एकादशी',
  'Gauna Kamada Ekadashi': 'गौण कामदा एकादशी',
  'Gauna Varuthini Ekadashi': 'गौण वरूथिनी एकादशी',
  'Gauna Mohini Ekadashi': 'गौण मोहिनी एकादशी',
  'Gauna Apara Ekadashi': 'गौण अपरा एकादशी',
  'Gauna Padmini Ekadashi': 'गौण पद्मिनी एकादशी',
  'Gauna Parama Ekadashi': 'गौण परम एकादशी',
  'Gauna Nirjala Ekadashi': 'गौण निर्जला एकादशी',
  
  // Amavasyas
  'Amavasya': 'अमावस्या', 'Shani Amavasya': 'शनि अमावस्या', 'Mauni Amavasya': 'मौनी अमावस्या',
  
  // Other vrats
  'Pradosh Vrat': 'प्रदोष व्रत', 'Pradosham': 'प्रदोष',
  'Akshaya Tritiya': 'अक्षय तृतीया',
  'Hariyali Teej': 'हरियाली तीज', 'Hartalika Teej': 'हरतालिका तीज', 'Kajari Teej': 'कजरी तीज',
  'Nag Panchami': 'नाग पंचमी',
  'Chhath Puja': 'छठ पूजा', 'Chhath': 'छठ',
  'Tulsi Vivah': 'तुलसी विवाह', 'Gita Jayanti': 'गीता जयंती',
  'Gudi Padwa': 'गुड़ी पड़वा', 'Ugadi': 'उगादी',
  'Vat Savitri': 'वट सावित्री', 'Jagannath Rath Yatra': 'जगन्नाथ रथ यात्रा',
  'Rath Yatra': 'रथ यात्रा',
  'Ganga Dussehra': 'गंगा दशहरा', 'Ganga Dashahara': 'गंगा दशहरा',
  'Vishwakarma Puja': 'विश्वकर्मा पूजा', 'Vishwakarma Jayanti': 'विश्वकर्मा जयंती',
  
  // Sankrantis
  'Sankranti': 'संक्रांति', 'Mesha Sankranti': 'मेष संक्रांति',
  'Vrishabha Sankranti': 'वृषभ संक्रांति', 'Mithuna Sankranti': 'मिथुन संक्रांति',
  'Karka Sankranti': 'कर्क संक्रांति', 'Simha Sankranti': 'सिंह संक्रांति',
  'Kanya Sankranti': 'कन्या संक्रांति', 'Tula Sankranti': 'तुला संक्रांति',
  'Vrishchika Sankranti': 'वृश्चिक संक्रांति', 'Dhanu Sankranti': 'धनु संक्रांति',
  'Kumbha Sankranti': 'कुंभ संक्रांति', 'Meena Sankranti': 'मीन संक्रांति'
};

function getHindiName_(name){
  if(FESTIVAL_HINDI[name]) return FESTIVAL_HINDI[name];
  // Try matching the festival name without suffix like "Vrat", "Dates"
  const cleaned = name.replace(/\s*(Vrat|Vratam|Dates|Vrata|Day|Days|Fasting)$/i, '').trim();
  if(FESTIVAL_HINDI[cleaned]) return FESTIVAL_HINDI[cleaned];
  // Partial match
  for(const key in FESTIVAL_HINDI){
    if(name.indexOf(key) >= 0) return FESTIVAL_HINDI[key];
  }
  return name;
}

function getFestivalEmoji_(name){
  const n = name.toLowerCase();
  if(n.includes('diwali') || n.includes('deepavali') || n.includes('dhanteras') || n.includes('lakshmi')) return '🪔';
  if(n.includes('holi')) return '🎨';
  if(n.includes('janmashtami') || n.includes('krishna')) return '🦚';
  if(n.includes('ganesh')) return '🐘';
  if(n.includes('navratri') || n.includes('navaratri') || n.includes('durga')) return '🛕';
  if(n.includes('shivaratri') || n.includes('shiv') || n.includes('pradosh')) return '🔱';
  if(n.includes('raksha') || n.includes('rakhi')) return '🪢';
  if(n.includes('karva') || n.includes('karwa')) return '🌙';
  if(n.includes('ekadashi')) return '🪷';
  if(n.includes('purnima') || n.includes('pournami')) return '🌕';
  if(n.includes('amavasya')) return '🌑';
  if(n.includes('teej')) return '🌿';
  if(n.includes('panchami')) return '🌸';
  if(n.includes('nag')) return '🐍';
  if(n.includes('hanuman')) return '🐒';
  if(n.includes('ram')) return '🏹';
  if(n.includes('dussehra') || n.includes('dasara') || n.includes('vijayadashami')) return '🏹';
  if(n.includes('makar') || n.includes('sankranti') || n.includes('pongal') || n.includes('lohri') || n.includes('vaisakhi') || n.includes('baisakhi')) return '🪁';
  if(n.includes('akshaya')) return '💰';
  if(n.includes('chhath')) return '☀';
  if(n.includes('buddha')) return '☸';
  if(n.includes('guru purnima')) return '🙏';
  if(n.includes('tulsi')) return '🌱';
  if(n.includes('rath yatra')) return '🛕';
  if(n.includes('vrat') || n.includes('fast')) return '🙏';
  if(n.includes('ganga')) return '💧';
  if(n.includes('vishwakarma')) return '🛠';
  if(n.includes('mahalaya') || n.includes('pitru') || n.includes('shraddha')) return '🙏';
  return '🎉';
}

// Strip HTML to text
function stripFestHtml_(html){
  html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  html = html.replace(/<!--[\s\S]*?-->/g, ' ');
  html = html.replace(/<meta[^>]*>/gi, ' ');
  html = html.replace(/<link[^>]*>/gi, ' ');
  html = html.replace(/<[^>]+>/g, ' ');
  html = html.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  html = html.replace(/&#x[0-9a-fA-F]+;/g, '');
  html = html.replace(/\s+/g, ' ').trim();
  return html;
}

// Fetch one month's festivals from Drik Panchang
function fetchDrikMonthFestivals_(year, month){
  // URL format: hinducalendar.html?year=2026 (yearly) or month-specific
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const url = 'https://www.drikpanchang.com/calendars/hindu/hinducalendar.html?year=' + year;
  
  Logger.log('Fetching Hindu calendar: ' + url);
  
  let html = '';
  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      }
    });
    html = resp.getContentText();
    Logger.log('HTTP ' + resp.getResponseCode() + ', size: ' + html.length);
  } catch(e){
    Logger.log('Fetch error: ' + e.message);
    return [];
  }
  
  if(!html || html.length < 5000) return [];
  
  let text = stripFestHtml_(html);
  Logger.log('Stripped text length: ' + text.length);
  
  // KEY FIX: Skip the navigation menu - find start of actual festival data
  // Marker: "Vikrama Samvata" or "Hindu Festivals [...]" appears just before festival list
  const startMarkers = ['Vikrama Samvata', 'Hindu Festivals [', 'January 2026', 'January ' + year];
  let dataStart = -1;
  for(let marker of startMarkers){
    const pos = text.indexOf(marker);
    if(pos > 0 && (dataStart < 0 || pos < dataStart)){
      dataStart = pos;
    }
  }
  
  if(dataStart > 0){
    text = text.substring(dataStart);
    Logger.log('Trimmed to festival data section, new length: ' + text.length);
    Logger.log('Sample first 500: ' + text.substring(0, 500));
  }
  
  // Parse festivals from text
  // Pattern: "Festival Name · MonthName Day, Year, Weekday"
  // OR: "MonthName Day, Year, Weekday Hindu_Month, Paksha Tithi"
  // Format from search: "Holi · March 4, 2026, Wednesday Chaitra, Krishna Pratipada"
  
  const events = [];
  // Build regex to find dates like "March 4, 2026"
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  
  // STRATEGY: Find ALL dates, split text into chunks, clean each festival name
  // Drik format per entry: "FestivalName Month Day, Year, Weekday HinduMonth, Paksha Tithi"
  // Example: "Pausha Purnima January 3, 2026, Saturday Pausha, Shukla Purnima"
  
  // Step 1: Find all date positions
  const dateOnlyRegex = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4}),\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/g;
  
  const dateMatches = [];
  let m;
  while((m = dateOnlyRegex.exec(text)) !== null){
    dateMatches.push({
      pos: m.index,
      length: m[0].length,
      month: m[1],
      day: parseInt(m[2]),
      year: parseInt(m[3]),
      weekday: m[4]
    });
  }
  
  Logger.log('Found ' + dateMatches.length + ' date matches');
  
  // Step 2: Words to strip from name (Hindu calendar metadata that leaks from previous entry)
  // Order matters - longer phrases first
  const stripPhrases = [
    // Paksha + Tithi combos (most common trailing pattern)
    'Shukla Pratipada','Shukla Dwitiya','Shukla Tritiya','Shukla Chaturthi','Shukla Panchami',
    'Shukla Shashthi','Shukla Saptami','Shukla Ashtami','Shukla Navami','Shukla Dashami',
    'Shukla Ekadashi','Shukla Dwadashi','Shukla Trayodashi','Shukla Chaturdashi','Shukla Purnima',
    'Krishna Pratipada','Krishna Dwitiya','Krishna Tritiya','Krishna Chaturthi','Krishna Panchami',
    'Krishna Shashthi','Krishna Saptami','Krishna Ashtami','Krishna Navami','Krishna Dashami',
    'Krishna Ekadashi','Krishna Dwadashi','Krishna Trayodashi','Krishna Chaturdashi','Krishna Amavasya'
  ];
  
  // Hindu month names (standalone trailing)
  const hinduMonths = ['Chaitra','Vaishakha','Jyeshtha','Ashadha','Shravana','Bhadrapada',
                       'Ashwin','Ashvina','Ashwina','Kartika','Kartik','Margashirsha','Pausha','Magha','Phalguna'];
  
  // Weekday short forms that can leak (Sun, Mon, etc.)
  const weekdayShorts = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  
  // Step 3: For each date, festival name is the TEXT chunk BEFORE the date,
  // starting from end of previous date (or start of trimmed text)
  for(let i = 0; i < dateMatches.length; i++){
    const dm = dateMatches[i];
    
    if(dm.year !== year) continue;
    
    const monthNum = months.indexOf(dm.month) + 1;
    if(monthNum < 1) continue;
    
    // Calculate start of name chunk
    const chunkStart = i === 0 ? 0 : (dateMatches[i-1].pos + dateMatches[i-1].length);
    let nameRaw = text.substring(chunkStart, dm.pos).trim();
    
    // Step 4: AGGRESSIVE CLEANING — strip junk from BEGINNING
    // Strip "HinduMonth, Paksha Tithi" combos that trail from previous entry
    // Pattern: starts with "Month, Paksha Tithi" or just "Paksha Tithi"
    
    // First: strip leading "HinduMonth, " if present
    for(let hm of hinduMonths){
      const re = new RegExp('^' + hm + ',?\\s+', 'i');
      if(re.test(nameRaw)) {
        nameRaw = nameRaw.replace(re, '').trim();
        break;
      }
    }
    
    // Then strip leading Paksha + Tithi pattern
    for(let sp of stripPhrases){
      if(nameRaw.indexOf(sp) === 0){
        nameRaw = nameRaw.substring(sp.length).trim();
        break;
      }
    }
    
    // Also strip just leading "Shukla" or "Krishna" + word
    nameRaw = nameRaw.replace(/^(Shukla|Krishna)\s+\w+\s+/i, '').trim();
    
    // Strip leading weekday shorts (Sun, Mon, etc.)
    for(let wd of weekdayShorts){
      const re = new RegExp('^' + wd + '\\s+', '');  // case-sensitive
      if(re.test(nameRaw)){
        nameRaw = nameRaw.replace(re, '').trim();
        break;
      }
    }
    
    // Also strip standalone Hindu month at start
    for(let hm of hinduMonths){
      const re = new RegExp('^' + hm + '\\s+', 'i');
      if(re.test(nameRaw)){
        nameRaw = nameRaw.replace(re, '').trim();
        break;
      }
    }
    
    // Strip any leading comma or punctuation
    nameRaw = nameRaw.replace(/^[,\s]+/, '').trim();
    
    // Take only first 1-5 words (festival names are short)
    const words = nameRaw.split(/\s+/).filter(Boolean);
    if(words.length === 0) continue;
    
    // Festival name: take up to first 5 words, but stop at lowercase word or known stopper
    let nameWords = [];
    for(let w of words){
      if(nameWords.length >= 5) break;
      // Stop at lowercase or stop-words
      if(!/^[A-Z]/.test(w)) break;
      // Stop at month/paksha/tithi words (they indicate end of name and start of metadata)
      if(hinduMonths.indexOf(w) >= 0) break;
      if(['Shukla','Krishna','Adhika'].indexOf(w) >= 0) break;
      nameWords.push(w);
    }
    
    if(nameWords.length === 0) continue;
    let festName = nameWords.join(' ').trim();
    
    // Final filter
    if(festName.length < 3 || festName.length > 50) continue;
    
    // Filter out single Rashi names (these are transit references)
    const rashiNames = /^(Mesha|Vrishabha|Mithuna|Karka|Simha|Kanya|Tula|Vrishchika|Dhanu|Makara|Kumbha|Meena|Dhanus)$/;
    if(rashiNames.test(festName)) continue;
    
    // Filter weekday names
    const weekdayNames = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/;
    if(weekdayNames.test(festName)) continue;
    
    // Filter standalone non-festival words (Hindu months, paksha, etc.)
    const nonFestivals = /^(Adhika|Nija|Mala|Shukla|Krishna|Purvi|Uttara|Dakshina|Vama|Vishnu|Shiva|Devi|Chaitra|Vaishakha|Jyeshtha|Ashadha|Shravana|Bhadrapada|Ashwin|Ashvina|Ashwina|Kartika|Kartik|Margashirsha|Pausha|Magha|Phalguna|Purvashadha|Mula|Nakshatra)[\s,]*$/i;
    if(nonFestivals.test(festName)) continue;
    
    // Filter entries that START with Hindu month + comma (means our cleaning didn't fully work)
    // e.g., "Ashwina, Purva" or "Ashwina, Mula Nakshatra Saraswati Puja"
    if(/^(Chaitra|Vaishakha|Jyeshtha|Ashadha|Shravana|Bhadrapada|Ashwin|Ashvina|Ashwina|Kartika|Kartik|Margashirsha|Pausha|Magha|Phalguna)[\s,]/i.test(festName)) {
      // Try to extract the actual festival name AFTER the month/comma
      const m = festName.match(/^(?:Chaitra|Vaishakha|Jyeshtha|Ashadha|Shravana|Bhadrapada|Ashwin|Ashvina|Ashwina|Kartika|Kartik|Margashirsha|Pausha|Magha|Phalguna)[\s,]+(.+)$/i);
      if(m && m[1]){
        // Re-clean - strip Paksha/Nakshatra prefix words
        let cleaned = m[1].trim();
        cleaned = cleaned.replace(/^(Shukla|Krishna|Purva|Uttara|Mula|Adhika)[\s,]+/i, '').trim();
        cleaned = cleaned.replace(/^Nakshatra[\s,]+/i, '').trim();
        if(cleaned.length >= 3 && /^[A-Z]/.test(cleaned)){
          festName = cleaned;
        } else {
          continue; // Can't extract real name, skip
        }
      } else {
        continue;
      }
    }
    
    // NOTE: Keep "Gauna" prefix festivals - they are alternate observance dates
    // e.g., "Gauna Yogini Ekadashi" is a valid secondary date for Ekadashi observance
    
    // Strip trailing comma/whitespace
    festName = festName.replace(/[,\s]+$/, '').trim();
    if(!festName || festName.length < 3) continue;
    
    // Filter eclipse-only entries (these have date but no Hindu fest significance for our portal)
    // Comment out next line if you WANT to show eclipses too
    // if(/^(Surya Grahan|Chandra Grahan)/.test(festName)) continue;
    
    // Skip navigation/menu items
    const skipPatterns = /^(More|Top|Festivals|About|Holidays|Calendar|Dates|Page|Click|Read|Login|Sign|Modern|Switch|This|Year|Choose|Gregorian|Lunar|Prev|Current|Next|Latitude|Longitude|Elevation|Olson|Timezone|Offset|Vikrama|Samvata|Home|Panchang|Month|Dainik|Assamese|Bengali|Tamil|Odia|Malayalam|Marathi|Gujarati|Kannada|Telugu|Nepali|ISKCON|Chandrabalam|Utilities|Vinchudo|Nakshatra|Calendars|Hindu|Indian|Sankranti Calendar|Diwali Calendar|Durga Puja|Shardiya|Chaitra Navratri|Muhurat|Choghadiya|Shubha Hora|Vivah|Griha|Property|Vehicle|Lagna|Gowri|Jain|Rahu Kala|Auspicious Yoga|Panchaka|Abhijit Muhurat|Vrat & Upavas|Ganesha Chaturthi$|Pradosham|Satyanarayana|Masik|Skanda|Karthigai|Shraddha Dates$|Janmashtami Dates$|Katha|Dashavatara|Navdurga|Vidhi|Deities|Regional|Gurus|Saints|Pilgrim|Places|Vishnu|Avatara|Jyotish|Kundali|Horoscope|Gemstone|Rudraksha|Janma|Rashifal|Moonsign|Birthstar|Mangal|Dosha|Kalasarpa|Shani|Sadesati|Baby|Sunsign|Sahasra|Pancha|Pakshi|Prashnavali|Planets|Planetary|Positions|Transit|Combustion|Retrograde|Eclipse|Solar|Seasons|Winter|Summer|Lyrics|Aarti|Chalisa|Stotram|Ashtakam|Vedic|Mantra|Yantra|Namavali|Saptashati|Sundarkand|Nama|Ramayanam|Gallery|Oil|Mehandi|Rangoli|Greetings|Bal|Miniature|Icons|Facebook|Pages|Others|Tutorials|Mobile|FAQ|Careers|Contact|Settings|Download|Change|En|Holi Rakhi Dussehra)/i;
    if(skipPatterns.test(festName)) continue;
    
    const dateStr = dm.year + '-' + String(monthNum).padStart(2,'0') + '-' + String(dm.day).padStart(2,'0');
    
    // Smart deduplication: 
    // Skip if exact name+date already exists
    if(events.find(e => e.date === dateStr && e.name === festName)) continue;
    
    // Check if a more specific or less specific version exists on same date
    const sameDate = events.filter(e => e.date === dateStr);
    let shouldSkip = false;
    let toRemove = -1;
    
    for(let j = 0; j < sameDate.length; j++){
      const existing = sameDate[j];
      // If new name is contained in existing name (less specific), skip new
      // e.g., existing="Vat Purnima Vrat", new="Purnima" - skip new
      if(existing.name.toLowerCase().indexOf(festName.toLowerCase()) >= 0 && existing.name.length > festName.length){
        shouldSkip = true;
        break;
      }
      // If existing is contained in new (existing is less specific), remove existing
      // e.g., existing="Purnima", new="Guru Purnima" - remove existing, add new
      if(festName.toLowerCase().indexOf(existing.name.toLowerCase()) >= 0 && festName.length > existing.name.length){
        // Find index in events array
        for(let k = 0; k < events.length; k++){
          if(events[k].date === existing.date && events[k].name === existing.name){
            toRemove = k;
            break;
          }
        }
        break;
      }
    }
    
    if(shouldSkip) continue;
    if(toRemove >= 0) events.splice(toRemove, 1);
    
    events.push({
      date: dateStr,
      name: festName,
      hindi: getHindiName_(festName),
      emoji: getFestivalEmoji_(festName)
    });
  }
  
  Logger.log('Parsed ' + events.length + ' festivals');
  return events;
}

