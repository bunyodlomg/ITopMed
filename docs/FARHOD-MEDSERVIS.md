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

## 2. Registratorni qo'shish (2 daqiqa)
1. **Xodimlar** bo'limida registratorning ismi, logini va parolini yozing.
2. Rollaridan **Registrator** va **Kassir** ni belgilang.
3. Kirish usulida **"Parolni hozir beraman"** ni tanlang → parolni qog'ozga yozing → **Xodimni qo'shish**.
4. Registrator o'z kompyuterida **itopmed.itoppos.uz/login** ni ochadi → shu login va parol bilan kiradi → **Qabulxona** bo'limi ochiladi. Unga Google Authenticator kerak emas.

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
3. **Qarz:** registratorning navbat ro'yxatida bemor tagidagi **"Qarzni olish"** → to'lovni qabul qilish.
4. **Excel:**
   - bemor kartasida → **Excel** tugmasi;
   - **Sozlamalar** → «Barcha bemorlarni Excel'da yuklab olish (ZIP)».

## Muammo bo'lsa
- **Kira olmayapti:**
  - login yoki parolni tekshiring;
  - xodim parolini unutsa: **Xodimlar** → xodimni oching → **"Yangi parol berish"**.
- **Farhod aka telefonini yo'qotsa:** tiklash kodlaridan biri bilan kiradi.
- **Internet uzilsa:** sayt ishlamaydi. Internet qaytgach, hammasi joyida bo'ladi — ma'lumot serverda saqlanadi. Har kuni 03:30 da zaxira nusxa olinadi.
