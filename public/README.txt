LOOK & FEEL PATCH — purane jaigahoi.in jaisa rang-roop
=====================================================

Is folder me sirf 4 files hain, aur sab "public" folder ki hain:

  look-and-feel/public/common.css        ->  <aapka repo>/public/common.css        (purani ko REPLACE karein)
  look-and-feel/public/common.js         ->  <aapka repo>/public/common.js         (purani ko REPLACE karein)
  look-and-feel/public/home.html         ->  <aapka repo>/public/home.html         (purani ko REPLACE karein)
  look-and-feel/public/shell-classic.css ->  <aapka repo>/public/shell-classic.css (NAYI file — common.css ke bagal me)

Yaani: public/ ke andar in 4 files ko copy-paste karein (same naam wali replace ho jayengi).
Baaki kuch nahi badalna — koi SQL nahi, koi Edge Function nahi, koi Apps Script nahi.

Phir deploy:
  firebase deploy --only hosting
Browser me pehli baar Ctrl+F5 (hard refresh) dabayein — purana CSS cache me ho sakta hai.

Kya badlega (har page par apne-aap, 50 pages ka HTML chhue bina):
  * Upar purani site jaisa sajaya hua Header (do gol logo, "❋ गहोई पोर्टल ❋")
  * Maroon Nav bar (pill buttons, Admin dropdown, Profile, Messages, Logout)
  * Neeche scrolling ticker (desktop) / Mobile par neeche 5 tab (Home, Search, Matrimony, Messages, You)
  * Har page ka title ab maroon hero banner, cards/buttons purane jaise
  * Home page: stats strip, quick tiles, "पंचांग & आगामी त्योहार" banner card
  * Classic / Royal: home par "Switch to Classic" pill, ya nav ke 🎨 se Display Settings

Kisi page par ye header/nav nahi chahiye to us page ke <body> me  data-no-shell  likh dein.
