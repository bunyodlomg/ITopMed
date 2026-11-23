# Farhod MedServis — shifokor fikrlari (23.11.2026)

Manba: 2 ta ovozli xabar (5:51 va 2:13). O'zbek tiliga o'qitilgan ikki model (`whisper-large-v3-turbo-uzbek`, `navaistt_v2_medium`) bilan mahalliy kompyuterda matnga o'girildi, natijalar solishtirib tiklandi.
Bemor ma'lumotlari yo'q. **[?]** — aniq eshitilmagan so'z.

## 1-audio — registratura, kassa, muhr, navbat

> Registrator registraturaga o'z logini bilan kirsin (hozir 1–3 ta, kelajakda 4 ta bo'lishi mumkin). Har biri o'z login-paroli bilan kirsa, faqat registraturaga oid qism ochilsin, qolgani ochilmasin.
>
> Kassir ham: nechta kassir bo'lsa, hammasi o'z login-paroli bilan kiradi — qaysi kassir nima ish qilgani, qaysi login bilan qanday ishlar qilingani bilinsin. Bitta to'lov ichida ikki usul belgilash mumkin bo'lsin: naqd va karta, yoki o'tkazma. Masalan 300 ming: 200 ming naqd, 100 ming karta. Umumiy hisobotda chiqib tursin — kun yakunida: bugun naqd 1 million, plastik kartaga 300 ming, jami 1 million 300 ming.
>
> Pechat (chop etish): doktor yozgandan keyin bemor registratorga uchraydi, registrator familiya-ismini kiritadi va pechat qilib beradi. Registrator pechat qilishi uchun kassa tomondan to'siq bo'lmasin — **yashil** bo'lsin. Doktor ichkarida xizmat qo'shib yuborishi mumkin — u kassada "to'lanmagan" deb tursin. Kassir to'lov qilindi deb belgilagandan keyingina registratorga pechatga ruxsat berilsin. Kassa pechat qilmaydi, doktor pechat qilmaydi — **pechat faqat registraturada**.
>
> Har bir doktorning kodi bo'lsin: 01, 02, 03 — kodni terib Enter bossa mutaxassislik avtomatik tanlansin ("01" — kardio). Doktorga faqat o'ziga kerak oyna ochilsin, boshqalarini ko'rmasin (chalkashlik bo'lmasin). Shifokor ko'rigida xizmat qo'shishi mumkin, lekin pechat imkoniyati bo'lmasin.
>
> Navbat: keyinchalik, ma'lumotlar yig'ilgandan keyin [?], har bir xizmatning vaqti yozilsin. Bemor keldi: umumiy UZI [?] 10 daqiqa, EXO 15 daqiqa, doktor ko'rigi 10 daqiqa — 35 daqiqa. Keyingi bemor taxminan shu soatdan keyin yozilsin; "navbatim qachon?" desa "taxminan soat …da" deya olsak yaxshi.
>
> Katta umumiy oyna faqat direktorda bo'lsin. Registraturada (1–3 kompyuter) faqat registratura, kassada faqat kassa, mutaxassisda faqat o'z shabloni ochilsin, boshqa joyga o'ta olmasin. Registratura: bemorni ro'yxatga olish, tekshiruv turlarini belgilash, tekshiruvdan keyin pechat. Laboratoriya qo'shilsa ham — kassa va registratura analizlarni belgilaydi, natija to'ldirilgach bemor kartasiga tushadi, registratura pechat qilib beradi.

## 2-audio — qabulxona (triaj) va funksional diagnostika (kelajak rejasi)

> Kelajakda "Qabulxona" bo'limi: doktorgacha bo'lgan ishlar — bo'y, vazn, tana massasi indeksi avtomatik, qon bosimi, puls, asosiy shikoyatlar. U yerda UASH/VOP (tor mutaxassisligi yo'q vrach) o'tiradi: nafas, yurak, shikoyatlar, perkussiya, palpatsiya — shablonlar bilan. Doktorga kirganda doktor qo'shimcha qiladi. "Ko'rsatilgan yordam" joyi: birinchi yordam, bosim baland edi — muolaja qilindi va h.k.
>
> "Funksional diagnostika" bo'limi: EKG, tredmil (yuklama testi), Xolter. Alohida xona va mutaxassis: apparat qo'yish, rasshifrovka, blankni pechatga tayyorlash.

## Talablar va loyihadagi holat

| # | Talab | Holat |
|---|---|---|
| 1 | Har bir registrator va kassir o'z login-paroli bilan; kim nima qilgani ko'rinadi | ✅ bor (alohida hisoblar, audit jurnali, kassa smenasi kassir bo'yicha) |
| 2 | Har bir rolga faqat o'z bo'limi; umumiy oyna faqat direktorda | ✅ bor (rollar: registrator, kassir, shifokor…) — Farhod akaning xodimlariga to'g'ri rol berilganini tekshirish |
| 3 | **Aralash to'lov: naqd + karta + o'tkazma bitta to'lovda** | ✅ **qo'shildi** (23.11): registraturada "Aralash" rejimi; yetmagan qismi qarz; chegirmadan keyin ortgani naqddan ayiriladi |
| 4 | **Kun yakunidagi hisobot: naqd / karta / jami** | ✅ **qo'shildi**: Hisobotlarda "Bugun" tugmasi, "Kassirlar bo'yicha (kim qabul qildi)" — har bir kassir uchun usullar bo'yicha |
| 5 | **To'lanmagan xizmat kassada qizil, to'langach yashil** | ✅ **qo'shildi**: "To'lanmagan" holati qizil; registratura navbatida to'lanmagan summa qizil |
| 6 | **Pechat faqat registraturada, faqat to'lovdan keyin; doktor va kassa chop etmaydi** | ✅ **qo'shildi**: Sozlamalar → "Hujjatlar faqat registraturada chop etiladi" (egasi yoqadi). Registraturada har bir bemor uchun "Chop etish" ro'yxati: ko'rik varag'i, retsept, UZI/EXO xulosalari — yashil bo'lmaguncha yopiq |
| 7 | Doktor kodi 01/02/03 → Enter → mutaxassislik | ❌ yo'q |
| 8 | Navbatda taxminiy vaqt (xizmat davomiyligidan) | 🟡 xizmatlarda davomiylik bor; navbatda taxminiy soat yo'q (shifokor: "ma'lumot yig'ilgandan keyin") |
| 9 | Laboratoriya natijasi bemor kartasiga, registratura chop etadi | 🟡 laboratoriya moduli bor; registraturadan chop etish yo'q |
| 10 | Qabulxona: bo'y, vazn, TMI avtomatik, QB, puls, shikoyatlar | 🟡 registraturada o'lchovlar va TMI bor; shikoyatlar va alohida "qabulxona" bo'limi yo'q (kelajak) |
| 11 | UASH/VOP ko'rik shablonlari (nafas, yurak, perkussiya, palpatsiya) | 🟡 shablon tizimi bor, mazmuni yaratiladi (kelajak) |
| 12 | "Ko'rsatilgan yordam" maydoni | ❌ yo'q (kelajak) |
| 13 | Funksional diagnostika: EKG, tredmil, Xolter, alohida mutaxassis | 🟡 diagnostika turlari bor (ECG, STRESS_TEST, HOLTER); alohida bo'lim yo'q (kelajak) |

## Eslatma
- "Faqat registraturada" yoqilganda eski (bugungi bo'lmagan) qabul hujjatini hech kim chop eta olmaydi — kerak bo'lsa keyin qaror qilinadi.
- [?] belgilangan ikki joyni (3:33) shifokordan tasdiqlash.
