# Farhod MedServis — shifokor fikrlari (22.11.2026)

Manba: 5 ta ovozli xabar (~39 daqiqa, Whisper large-v3 bilan GPU'da matnga o'girildi), 14 ta .docx shablon, narxnoma va to'ldirilgan "Kardiolog ko'ruvi" varag'ining rasmi.
Bemor ma'lumotlari bu hujjatga kiritilmagan.

## Shifokor aytgan ustuvorlik (birinchi ishga tushishda)
1. Bemorni ro'yxatga olish + ko'rik shablonlari
2. Registratura va kassa
3. Shifokor qabuli

## Talablar va loyihadagi holat

| # | Talab (shifokor so'zlari bo'yicha) | Holat |
|---|---|---|
| 1 | Registrator, kassir, shifokor — alohida rollar; to'lov kassada, so'ng registratura chop etadi | ✅ bor (rollar, qabulxona, kassa) |
| 2 | Bemor: F.I.Sh., tug'ilgan yili, telefon, Telegram, kim yubordi (shifokor / o'zi / reklama) | ✅ bor (referral source) |
| 3 | Onlayn va jonli navbat bir-biriga xalaqit bermasin; onlayn yozilgan vaqt band bo'lsin | ✅ bor (slot, buffer) |
| 4 | Kutish zalida TV: navbat ko'rinadi, "Keyingi" tugmasi ovoz bilan chaqiradi | ✅ bor (`/tv`, speechSynthesis) |
| 5 | Imtiyozlar (nafaqaxo'r, faxriy…) foizda, paket narxlar, 10 kun ichida qayta ko'rik bepul, istisno + sabab | ✅ bor (Chegirmalar sahifasi) — istisno sababini yozish tekshirilsin |
| 6 | Chek printeri 80/58 mm | ✅ bor |
| 7 | Ko'rik: shikoyatlar belgilab tanlanadi, oldingi ko'rikdan nusxa, anamnez (allergiya, chekish, qandli diabet, infarkt, irsiyat, operatsiyalar) | ✅ bor |
| 8 | Vitallar: QB, puls, SpO2, vazn, bo'y → BMI avtomatik; shish darajasi (oyoqda/yuzda/butun tanada) | ✅ bor — shish darajasi tanlovi tekshirilsin |
| 9 | Kalkulyatorlar (SCORE, CHA₂DS₂-VASc, HAS-BLED, SKF/eGFR…) | ✅ bor |
| 10 | Tashxis MKB-10 kodi bilan; asosiy / hamroh / asorat alohida; bosqich va darajalar | ✅ bor |
| 11 | Xulosa varag'i: blank (logo, litsenziya, manzil, telefon), imzo, muhr, keyingi ko'rik sanasi, QR (manzil/lokatsiya) | ✅ bor |
| 12 | Retsept: INN + savdo nomi, tayyor sxemalar (tahrirlanadi), allergiya/o'zaro ta'sir ogohlantirishi, vaqtlar (qizil), ovqatdan oldin/keyin, titrlash | ✅ bor (oxirgi commitlar) |
| 13 | Tabletka bo'laklari rasmi (½, ¼, ⅛, ¾) | ✅ bor — **1/3, 1/5, 1/6, 3/5 yo'q** (faqat 2/4/8 maxraj) |
| 14 | Tahlillar retseptda alohida rangda ajralib tursin (bemor e'tibor bersin) | ✅ bor — rang tekshirilsin |
| 15 | Dispanser: gipertoniya, yurak yetishmovchiligi, bo'lmachalar fibrillyatsiyasi (INR dinamikasi) | ✅ bor |
| 16 | Eslatmalar Telegram orqali: qabuldan 1 kun oldin, dori ichish, tahlil topshirish, kelmagan bemorga qayta yozilish | ✅ bor |
| 17 | Bemor uyda o'lchagan QB/pulsni bot orqali yuboradi | ✅ bor |
| 18 | Natijalar Telegram bot orqali (kod bilan kirib, xulosani ko'radi) | ✅ bor (RESULTS_READY, Mini App) |
| 19 | Shifokor ulushi: oylik yoki foiz; shifokor o'z daromadini kun/hafta/sana oralig'i bo'yicha ko'radi | ✅ bor (`my-earnings`) |
| 20 | To'lov: naqd, Payme/Click o'tkazma; terminal keyin | ✅ bor |
| **21** | **14 ta UTT/EXO/kardiolog shabloni (o'z me'yorlari bilan) tizimda tayyor bo'lsin** | ❌ **yo'q** — mexanizm bor, Farhod akaning shablonlari kiritilmagan |
| **22** | **EXO: o'lchovlar jadvali (KDR, KDO, KSR, KSO, FV Teicholz/Simpson, FU, UO, MO, E/A, TAPSE…)** | ✅ Farhod akaning EXOKG shabloni (45 maydon, o'z me'yorlari); 24.11: KDO, KSO, FV (Teyxolts), FU, UO, MO, E/A, ChQ massasi va indeksi **avtomatik hisoblanadi** |
| **23** | **EXO: me'yordan tashqari qiymatlardan taxminiy xulosa (shifokor tahrirlaydi)** | ✅ 24.11: "Xulosa qoralamasi" tugmasi — barcha diagnostika shablonlarida |
| **24** | **EXO: chap qorincha segmentlari sxemasi — akinetik/gipokinetik zonalar rangli** | ❌ yo'q (`wallMotion` — oddiy matn) |
| **25** | **Hisobotlar: tashxislar statistikasi (MKB-10 bo'yicha), dorilar statistikasi (beta-blokator, antikoagulyant necha % bemorga), yangi / qayta kelgan bemorlar** | 🟡 qisman — yangi bemorlar bor; tashxis va dori statistikasi yo'q |
| **26** | **Davolanishdan 5 kun keyin bemordan fikr so'rash (Telegram)** | ❌ yo'q |
| **27** | **Navbat: "navbatingizga 1 soat qoldi" xabari; kechiksa ogohlantirish; vaqt avtomatik suriladi** | 🟡 tekshirilsin |
| 28 | EKG apparatini kompyuterga ulash, rasmni avtomatik biriktirish | 🟡 fayl biriktirish bor; apparat integratsiyasi — qurilmaga bog'liq |
| 29 | DICOM (EXO rasmlari) | ⏳ keyin — klinikada DICOM ulanmagan |
| 30 | Holter, SMAD, stress-test, laboratoriya | ⏳ keyin (klinika rejasida) |
| 31 | Yuboruvchi shifokorlarga foiz | ⏳ keyin (shifokorning o'zi "kelajakda" dedi) |
| 32 | Fiskal kassa / soliq | ⏳ hozir kerak emas |
| 33 | Onlayn konsultatsiya (video) | ⏳ keyin |
| 34 | Interfeys o'zbek lotinida | ✅ bor |

## Narxnoma (xizmatlar ro'yxatiga kiritish uchun)
Umumiy qorin bo'shlig'i UTT — 100 000 · Hazm tizimi UTT — 70 000 · Buyrak va siydik yo'llari UTT — 70 000 ·
Prostata + siydik pufagi UTT — 60 000 · Bachadon va ortiqlari UTT — 60 000 · Homiladorlik 4–12 hafta — 70 000 ·
Homiladorlik 12–40 hafta — 70 000 · Qalqonsimon bez — 70 000 · Yorg'oq — 80 000 · EhoKG — 120 000 · EKG — 30 000 ·
Kardiolog ko'rigi — 100 000 · Umumiy qon tahlili — 30 000.
(Narxlar ro'yxatini matn sifatida joylash funksiyasi bilan bir zumda kiritiladi.)

## Shablonlar (14 ta .docx)
Homiladorlik I trimestr · Homiladorlik II–III trimestr (fetometriya + doppler jadvali) · Qorin bo'shlig'i umumiy (ayollar) ·
Qorin bo'shlig'i umumiy (erkaklar) · Hazm tizimi · Oshqozon · Buyraklar va prostata · Bachadon va ortiqlari ·
Qalqonsimon bez (hajm, IN %, giperplaziya/gipoplaziya darajalari) · Yorg'oq · Yuza a'zolar · EXOKG (transtorakal) ·
Kardiolog ko'ruvi · Ma'lumotnoma.
Barchasi kirill yozuvida va har bir o'lchovda shifokorning o'z me'yori bor (masalan, "N-80-130 мм").
Bu aynan `key | Label | unit | min-max | normal` formatiga mos keladi.

## Taklif etilgan ish tartibi
1. **Farhod akaning 14 ta shablonini klinikasiga import qilish** (#21) — maydonlar, me'yorlar va hisobot matni o'z hujjatlaridan olinadi.
   Narxnomani ham kiritish. Ta'siri eng katta va eng tez qilinadi.
2. **EXO: to'liq o'lchovlar jadvali + taxminiy xulosa** (#22, #23).
3. **Tabletka bo'laklari: 1/3, 1/5, 1/6, 2/3, 3/5** (#13).
4. **Hisobotlar: tashxis va dori statistikasi** (#25).
5. **Davolanishdan keyin fikr so'rash** (#26) va navbat xabarlarini tekshirish (#27).
6. **EXO segmentlar sxemasi** (#24).
