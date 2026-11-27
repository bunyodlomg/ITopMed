# Farhod MedServis — ishga tushirish (qisqa)

Manzil: **https://itopmed.itoppos.uz/login** (internet orqali). Hech narsa o'rnatilmaydi.

## 0. Klinika ochilgan (15.11.2026)
- Manzil: **https://itopmed.itoppos.uz/c/farhod-medservis**
- Egasi va shifokor: **Qoraboyev Farhod**. Kirish — login va parol; keyin Telegram ulanadi.
- Parol: Telegram orqali yuborilgan **bir martalik havola** bilan Farhod aka o'zi qo'yadi. Havola 72 soat amal qiladi va faqat bir marta ishlaydi.
- Havola eskirsa, serverda yangisini chiqaring: **Parolni unutdingizmi?** yoki SuperAdmin'dan so'rang.
- **Yangilanish:** dastur serverda turadi. Har bir yangi versiya hammaga o'zi yetib boradi, klinikada hech narsa qilish kerak emas.

Boshqa klinikani shu tarzda ochish (serverda):
```bash
/opt/itopmed/bin/itopmed-clinic farhod-medservis farhod.admin "Ism Familiya"
```

## 0.1. Shifokorning Word blankalari dasturda (22.11.2026)
Farhod aka yuborgan 16 ta Word fayl (`scripts/deploy/clinics/farhod-medservis.json`) — kirillchadan lotinchaga o'girilgan, me'yorlar faqat blankada yozilganicha:
- **Diagnostika shablonlari (12):** homiladorlik I va II–III trimestri, qorin bo'shlig'i umumiy (ayollar / erkaklar), hazm tizimi, oshqozon va 12 barmoqli ichak, buyraklar + siydik pufagi + prostata, bachadon va ortiqlari, qalqonsimon bez, yorg'oq, yuza a'zolar, transtorakal exokardiografiya.
- **Hujjatlar:** «Kardiolog ko'ruvi varag'i» (pastida shifokor telefoni, Telegram savollar uchun), «Ambulator davolanish haqida ma'lumotnoma».
- **Ko'rik shabloni:** «Kardiolog ko'ruvi: ko'rik va tavsiyalar» (ko'rik matni va sayr/ovqatlanish tavsiyalari).
- **Narxnoma:** 13 ta xizmat, shifokor narxlari bilan. Eski nomlar (UZI) yangisiga o'zgartiriladi — tarix saqlanadi; «Umumiy erkaklar UZI» arxivlanadi (narxnomada umumiy qorin UTT bitta).
- **Blank:** logotip (yurak belgisi) va shifokor telefoni — faqat bo'sh bo'lsa qo'yiladi.

Serverda qo'llash (yangi versiya o'rnatilgandan keyin; klinika o'zgartirgan narsalar ustidan yozilmaydi, qayta ishga tushirish xavfsiz):
```bash
sudo /opt/itopmed/bin/itopmed-clinic farhod-medservis --update
```
Keyin **Shablonlar** sahifasida eski «Kardiolog ko'ruvi» hujjati kerak bo'lmasa — arxivlang.

## 0.2. Ishga tushirish kuni: sinov bemorlarini tozalash
Sinab ko'rishda kiritilgan bemorlar haqiqiy ish boshlanishidan oldin o'chiriladi:
1. Farhod aka (klinika egasi) **Sozlamalar** → **«Sinov bemorlarini tozalash»** kartasini ochadi.
2. Maydonga klinika manzilini yozadi: `farhod-medservis` → **Barcha bemorlarni o'chirish**.
3. O'chadi: barcha bemorlar, navbat, qabullar, ko'rik yozuvlari, tashxislar, retseptlar, tekshiruv natijalari, hisoblar, to'lovlar, kassa smenalari. Navbat raqamlari yana 1 dan boshlanadi.
4. Qoladi: xodimlar, xizmatlar va narxlar, shablonlar, jadval, sozlamalar, blank, audit jurnali (faqat sonlar yoziladi).

Faqat klinika egasi bajara oladi (dastur va ma'lumotlar bazasi ikkalasi tekshiradi). **Qaytarib bo'lmaydi** — haqiqiy bemorlar kiritilgandan keyin ishlatilmaydi.

## 1. Klinikada — Farhod akaning kompyuterida (10 daqiqa)
1. Chrome yoki Edge'da **itopmed.itoppos.uz/login** ni oching → login va parol bilan kiring.
2. Telefoniga **Google Authenticator** o'rnating → ekrandagi QR kodni skanerlang → 6 xonali kodni kiriting.
3. **Tiklash kodlarini yarating** → qog'ozga yozib, seyfga qo'ying.
4. **Sozlamalar** bo'limida:
   - klinika manzili va telefonini yozing;
   - **"Hujjat blanki"** → logotip va litsenziya qatori.
5. **Shifokorlar va jadval** → ish kunlari va soatlarini tekshiring. Standart: Du–Ju, 9:00–18:00. Shanba ishlasa, qo'shing.
6. **Shablonlar** → **"Kardiolog ko'ruvi"** → kerak bo'lsa pastiga qo'shimcha qator yozing. Masalan: `Tel: +998 .. ... .. .. (Telegram savollar uchun)`.
7. Brauzer menyusidan **"Ilovani o'rnatish"** ni tanlang — ish stolida ITop Med belgisi paydo bo'ladi.

## 2. Uch ish o'rni: Farhod aka, Qabulxona, Kassa (27.11.2026)
- **Farhod aka** — klinika egasi va shifokor (rollar: egasi, shifokor, bosh shifokor, registrator). **Pul qabul qilmaydi**: qabul paytida qo'shgan xizmati (EhoKG, EKG…) to'lanmagan holda Kassaga tushadi.
- **Qabulxona** (rol: Registrator) — bemorni yozadi, xizmatlarni belgilaydi, bosim/vazn/bo'y/pulsni yozadi, talon beradi. Registrator roliga qo'shilgan: «Xizmatlarni hisobga qo'shish» (`billing.charge`) va «Hayotiy ko'rsatkichlarni kiritish» (`vitals.write`). Pul olmaydi, tibbiy yozuvlarni ko'rmaydi.
- **Kassa** (rol: Kassir) — **Kassa: to'lov** sahifasida bemorning hamma to'lanmagan xizmatlari: to'liq / aralash / bir qismi, chek; kun boshida smenani ochadi, oxirida yopadi.
- Yangi xodim: **Xodimlar → Xodim qo'shish** → ism, rol, login, parol. Parolni unutsa: xodimni oching → **Yangi parol berish**.

Serverda (egasining paroli kerak emas, har bir amal ilovadagi tekshiruvlar va audit bilan):
```bash
sudo /opt/itopmed/bin/itopmed-clinic farhod-medservis --admin /root/ops.json   # scripts/lib/clinic-admin.ts
```
`ops.json` — amallar ro'yxati: `role-permissions`, `owner-roles`, `remove-member`, `add-staff` (birinchi parol bir marta ekranga chiqadi), `purge-patients`.

To'liq qo'llanma rasmlar bilan: `docs/pdf/ITopMed-Farhod-MedServis-qollanma.pdf` (rasmlar: `scripts/docs/farhod-screenshots.ts`).

## 3. Printerlar
- **A4 printer** (ko'rik varag'i va retsept uchun) va **chek printeri** (80 yoki 58 mm) Windows'ga odatdagidek ulanadi.
- Chop etish oynasida kerakli printerni tanlaysiz:
  - talon va chek → chek printeri;
  - "Kardiolog ko'ruvi" varag'i → A4 printer.
- Chek **fiskal emas** (soliq kassasi emas).

## 4. Birinchi bemor bilan sinab ko'ring
1. **Registrator — Qabulxona** sahifasida:
   - familiya, ism, tug'ilgan yili (masalan 1958) va manzilni yozing;
   - xizmatlarni belgilang;
   - to'lovni tanlang: **to'liq / qisman / qarzga**;
   - bosim, vazn, bo'y, pulsni yozing;
   - **Navbatga qo'shish** → navbat raqami chiqadi → **talon** va **chek**ni chop eting.
2. **Shifokor — Bugungi bemorlarim** sahifasida:
   - bemor kirmasdan oldin uning yoshi, bosimi, to'lovi va qarzi ko'rinadi;
   - **Qabulni boshlash** → shablon → yozing → **Imzolash**;
   - tashxis va retseptni qo'shing;
   - kerak bo'lsa **EXO / EKG**'ni qo'shing (to'lab yoki qarzga);
   - **"Kardiolog ko'ruvi"** varag'ini chop etib, bemorga bering. Unda narx yo'q.
3. **Qarz:** Kassa → **Kassa: to'lov** → bemorni topib → to'lov (qolgan qarz shu ro'yxatda turadi).
4. **Excel:**
   - bemor kartasida → **Excel** tugmasi;
   - **Sozlamalar** → «Barcha bemorlarni Excel'da yuklab olish (ZIP)».

## Muammo bo'lsa
- **Kira olmayapti:**
  - login yoki parolni tekshiring;
  - xodim parolini unutsa: **Xodimlar** → xodimni oching → **"Yangi parol berish"**.
- **Farhod aka telefonini yo'qotsa:** tiklash kodlaridan biri bilan kiradi.
- **Internet uzilsa:** sayt ishlamaydi. Internet qaytgach, hammasi joyida bo'ladi — ma'lumot serverda saqlanadi. Har kuni 03:30 da zaxira nusxa olinadi.
