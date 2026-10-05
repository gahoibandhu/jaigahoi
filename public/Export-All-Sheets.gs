// ============================================================================
//  GAHOI PORTAL — Google Sheet -> CSV exporter (migration ke liye)
//  Is file ko US Apps Script project mein daalo jo live Google Sheet se bandha hai
//  (Sheet -> Extensions -> Apps Script). Purana Code.gs na badlo — ye alag file banao
//  (jaise Export.gs). Function naam sab "exp" se shuru hain taaki Code.gs se na takraayein.
//
//  Kaise chalana hai:
//   1. exportAllSheetsToDrive() Run karo (pehli baar permission maangega: Drive + Sheets).
//   2. Logger mein Drive folder ka link aayega: "Gahoi-Export-YYYY-MM-DD".
//      Usme har sheet ki CSV + _manifest.csv (row counts — baad mein verify ke kaam aayega).
//   3. Folder ko download karke scripts/ ke paas rakho (MIGRATION-RUNBOOK.md dekho).
//
//  Dhyan: Date cells ISO text mein jaate hain ("2026-03-04 00:00:00" jaisa), numbers
//  string mein — taaki mobile/pincode mein ".0" ya gayab hue zero ki dikkat na aaye.
//  Passwords wali column export HOTI hai (Members.Password) par migrate-members.js use
//  kabhi copy nahi karta (auth_uid NULL + invite-email). Phir bhi CSV files private rakho
//  aur migration ke baad Drive se delete kar do.
// ============================================================================

var EXP_SHEETS = [
  'Members', 'Matrimony', 'MatInterest', 'MahasabhaMembers', 'MahasabhaPayments',
  'BusinessDir', 'JobBoard', 'CommunityEvents', 'Gallery', 'Dharmshala', 'Magazine', 'Offers',
  'Messages', 'GahoiSpace', 'SpaceComments', 'Ledger',
  'PendingSignups', 'AuditLog', 'AknaList', 'PendingAknas',
  'Referrals', 'SignupNotifyEmails', 'TierPayments', 'HiddenSuggestions',
  'LoginHistory', 'Activity', 'Notifications', 'BulkInvite', 'Panchang', 'Festivals'
];

function expCell_(v, tz) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(v);
}

function expCsv_(rows, tz) {
  return rows.map(function (r) {
    return r.map(function (c) {
      return '"' + expCell_(c, tz).replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\n');
}

function exportAllSheetsToDrive() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd_HHmm');
  var folder = DriveApp.createFolder('Gahoi-Export-' + stamp);
  var manifest = [['Sheet', 'DataRows', 'Columns', 'Status']];

  EXP_SHEETS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { manifest.push([name, 0, 0, 'SHEET NOT FOUND (skip)']); return; }
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 1) { manifest.push([name, 0, 0, 'EMPTY']); return; }
    var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
    folder.createFile(name + '.csv', '\uFEFF' + expCsv_(values, tz), MimeType.CSV);
    manifest.push([name, lastRow - 1, lastCol, 'OK']);
    Logger.log(name + ': ' + (lastRow - 1) + ' rows x ' + lastCol + ' cols');
  });

  // Script Properties wali chhoti cheezein (visitor counter) bhi manifest ke saath
  try {
    var vc = PropertiesService.getScriptProperties().getProperty('visitor_count') || '0';
    manifest.push(['_property:visitor_count', vc, '', 'INFO']);
  } catch (e) {}

  folder.createFile('_manifest.csv', '\uFEFF' + expCsv_(manifest, tz), MimeType.CSV);
  Logger.log('DONE. Folder: ' + folder.getUrl());
  return folder.getUrl();
}

// Sirf ek sheet dobara export (agar kisi ka timeout/error aaya ho)
function exportOneSheet() {
  var NAME = 'Members';   // <-- yahan sheet ka naam badlo
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(NAME);
  if (!sh) { Logger.log('Sheet nahi mili: ' + NAME); return; }
  var values = sh.getDataRange().getValues();
  var f = DriveApp.createFile(NAME + '.csv', '\uFEFF' + expCsv_(values, ss.getSpreadsheetTimeZone()), MimeType.CSV);
  Logger.log(NAME + ' -> ' + f.getUrl());
}
