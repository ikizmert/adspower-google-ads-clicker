# AdsPower Google Ads Clicker

AdsPower anti-detect browser ile Google reklam tıklama + organik hit üretme aracı.

## Kurulum

```bash
npm install
```

AdsPower uygulamasının çalışıyor olması gerekir (`http://local.adspower.net:50325`).

## Pilot Profil Mantığı

- AdsPower'da bir **pilot profil** oluştur (ismi içinde "pilot" geçsin → kod onu otomatik dışlar)
- Pilot'u GUI'den ayarla: rotating proxy, "Random fingerprint: Enabled"
- Pilot'tan istediğin kadar **klon profil** çıkar (GUI'den manuel)
- Klonlar otomatik olarak pilot'un proxy'sini ve random fingerprint ayarını miras alır

## Kullanım

### 1. Pilot cookie'lerini export et (bir kerelik)

```bash
npm run export-pilot
```

- Pilot profili açar
- Tüm cookie'leri (Google "trust" cookie'leri dahil) `pilot-cookies.json`'a kaydeder
- Pilot'u kapatır
- **Pilot cookie'leri eskidiğinde** (örn. ayda bir) tekrar çalıştır

`config.json`'da `adspower.pilot_profile_id` doğru pilot ID'sine ayarlı olmalı.

### 2. Kampanyayı başlat

```bash
npm start
```

Her session başında:
1. Klon profil açılır
2. Tüm storage temizlenir (eski cookie/cache silinir)
3. Pilot cookie'leri yüklenir → Google için "tanıdık kullanıcı"
4. Fingerprint AdsPower tarafından otomatik random
5. Proxy rotating → yeni IP

### 3. Profilleri listele

```bash
npm run profiles
```

## Config (`config.json`)

```json
{
  "adspower": {
    "api_url": "http://local.adspower.net:50325",
    "pilot_profile_id": "k1c85tdt"
  },
  "behavior": {
    "max_run": 3,                    // toplam session sayısı
    "max_total_clicks": 0,           // 0 = sınırsız, sayıya ulaşınca dur
    "idle_timeout_minutes": 5,       // 5 dk tıklama olmazsa dur (0 = devre dışı)
    "browser_count": 3,              // paralel browser
    "headless": false,               // true = görünmez mod
    "block_images": true,            // resim yüklemeyi engelle (proxy bandwidth)
    "ad_page_min_wait": 10,          // reklam/site sayfasında min bekleme (sn)
    "ad_page_max_wait": 15,          // max bekleme
    "check_shopping_ads": true,
    "wait_factor": 0.5               // tüm beklemeleri çarpar (0.5 = yarı yarıya)
  }
}
```

## Queries (`queries.txt`)

Format: `arama metni @reklam_domain1#reklam_domain2 !hit_domain1!hit_domain2`

```
kuşadası adel çiçek@adelcicek.com!kusadasicicek.com!kusadasicicekcilik.com
kuşadası çiçek gönder@adelcicek.com#adacicek.com!kusadasicicek.com
```

- `@` → reklam domain hedefleri (tıklanır)
- `#` → reklam için ek domain'ler (OR mantığı)
- `!` → organik hit hedefleri (her biri ayrı domain)
- Reklam domain'leri **3 sayfaya kadar** aranır
- Organik domain'ler **5 sayfaya kadar** aranır

## Akış

1. Profil seçilir (en uzun süre önce kullanılan veya hiç kullanılmayan)
2. Cache + cookie temizlenir, pilot cookie yüklenir
3. Her query için:
   - Google'a gidilir, arama yapılır (input'a yazma + Enter)
   - Reklamlar bulunur, **yeni sekmede** açılır → 10-15s gezinir → kapanır
   - Organik hit domain'ler bulunur, **yeni sekmede** açılır → gezinir → **session sonuna kadar açık kalır**
   - Sıralama bilgisi (`rankings.json`) kaydedilir
4. Session sonunda domain bazlı kümülatif tıklama sayısı (`clicks.json`) basılır
5. Browser kapanır
6. Sonraki session: yeni profil

## Profil Yönetimi

- Mobil profiller (ismi/grubu "mobile/android/iphone/ipad/ios" içeren) **otomatik atlanır**
- Pilot profil (ismi "pilot/test/template" içeren) **otomatik dışlanır**
- 5 session sonra veya 3 üst üste 0 reklam → profil "sıfırlanır" (cache temizlenir)

## Durdurma

- **Ctrl+C** ile durdurursan da toplam tıklama özeti basılır
- `idle_timeout_minutes` süresince tıklama olmazsa otomatik durur
- `max_total_clicks` sayısına ulaşınca durur

## Dosyalar

- `pilot-cookies.json` (gitignored) — pilot'tan export edilen cookie'ler
- `profiles.json` (gitignored) — profil kullanım istatistikleri
- `clicks.json` (gitignored) — domain başına kümülatif tıklama
- `rankings.json` (gitignored) — organik sıralama geçmişi
