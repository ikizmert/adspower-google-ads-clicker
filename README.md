# AdsPower Google Ads Clicker — Model 0

AdsPower anti-detect browser ile Google reklam tıklama (rakip bütçe yakma) + organik hit üretme aracı.

## Strateji: Model 0 — Disposable Aggressive Click Velocity

Her session disposable ("tek kullanımlık"). Trust biriktirmek yerine **velocity** ve **rakip bütçe yakma** önceliği. AdsPower fingerprint her browser açılışında otomatik regenerate (`Random fingerprint: Enabled` ile). Adaptive target tracking — rakibin reklamı 3 ardışık aramada görünmüyorsa "bütçesi muhtemelen bitti" sayılır, gün sonuna kadar atlanır.

## Kurulum

```bash
npm install
```

AdsPower uygulamasının çalışıyor olması gerekir (`http://local.adspower.net:50325`).

## Profil Yönetimi (AdsPower GUI)

- **Random fingerprint: Enabled** olan profiller hazırla (her startup'ta yeni fingerprint regenerate edilir)
- Profil isimleri "pilot/test/template" içermesin (kod onları otomatik dışlar)
- Mobil profiller (ismi/grubu "mobile/android/iphone/ipad/ios" içeren) **otomatik atlanır**
- 22 profil baseline (kod bunu varsayar, daha çok profile başarıya doğrudan etki eder)

## Konfigürasyon (`config.json`)

`config.example.json`'u `config.json` olarak kopyalayıp doldur:

### Proxy Rotation

```json
"proxy_rotation": {
  "enabled": true,
  "providers": [
    {
      "name": "aproxy",
      "weight": 70,
      "type": "http",
      "host": "gw.aproxy.com",
      "port": "2312",
      "base_user": "ap-fcfvp9r45zxh",
      "password": "...",
      "cities": ["AYDIN", "IZMIR", "MUGLA", "ANTALYA", "ISTANBUL", "BURSA", "ANKARA"]
    }
  ]
}
```

- Her session **rastgele provider seçilir** (`weight` ağırlıklı)
- Her session **rastgele şehir seçilir** (provider'ın `cities` listesinden)
- İkinci provider eklemek için `providers` array'ine yeni obje ekle, weight'leri ayarla (örn. primary=70, secondary=30)

### Behavior

```json
"behavior": {
  "browser_count": 5,
  "max_clicks_per_domain_per_session": 3,
  "ad_page_min_wait": 8,
  "ad_page_max_wait": 15,
  "wait_factor": 1.0,
  "captcha_solve_timeout_seconds": 60,
  "profile_cooldown_minutes": 10,
  "captcha_failure_cooldown_minutes": 15,
  "filler_queries_per_session": 2,
  "adaptive_targeting": {
    "enabled": true,
    "missed_threshold": 3
  },
  "screenshot_on_click": true,
  "max_run": 0,
  "max_total_clicks": 0,
  "idle_timeout_minutes": 5
}
```

| Alan | Anlam |
|---|---|
| `browser_count` | Paralel browser sayısı |
| `max_clicks_per_domain_per_session` | Bir session içinde aynı domain'e max kaç kez tıklanır (multi-page) |
| `ad_page_min_wait`/`max_wait` | Reklam landing page'inde gezinme süresi (saniye) |
| `wait_factor` | Tüm beklemeleri çarpan (1.0 = normal, 0.5 = yarı yarıya) |
| `captcha_solve_timeout_seconds` | CapSolver bekleme süresi |
| `profile_cooldown_minutes` | Başarılı session sonrası profil tekrar kullanılana kadar bekleme |
| `captcha_failure_cooldown_minutes` | Captcha çözülemediğinde profil cooldown |
| `filler_queries_per_session` | Her session başında alakasız Google araması sayısı (0 = off) |
| `adaptive_targeting.enabled` | Rakibin reklamı görünmüyorsa exhausted işaretleme |
| `adaptive_targeting.missed_threshold` | Kaç ardışık miss → exhausted |
| `screenshot_on_click` | Tıklama anında screenshot al |
| `max_run` | Toplam session sayısı limit (0 = sınırsız) |
| `max_total_clicks` | Toplam tıklama limit (0 = sınırsız) |
| `idle_timeout_minutes` | X dk tıklama olmazsa otomatik dur |

## Queries (`queries.txt`)

Format: `arama metni @reklam_domain1#reklam_domain2 !hit_domain1!hit_domain2`

```
kuşadası çiçekçi@adelcicek.com#denizcicekcilik.com#hizlicicek.com
```

- `@` → reklam domain hedefleri (tıklanır)
- `#` → reklam için ek domain'ler (OR mantığı)
- `!` → organik hit hedefleri
- Reklam domain'leri **3 sayfaya kadar** aranır
- Organik domain'ler **5 sayfaya kadar** aranır

## Filler Queries (`filler-queries.txt`)

Her session başında rastgele seçilen alakasız sorgular. Bu aramalar `clicks.json` ve `rankings.json`'a **yazılmaz** (count'a girmez).

```
hava durumu
namaz vakitleri
süper lig puan durumu
...
```

## Çalıştırma

```bash
npm start
```

CLI argümanı ile sadece tek serial:
```bash
npm start 41
```

Passive mod (manuel test için):
```bash
npm start -- --passive
```

## Akış (Model 0)

1. Profil seçilir (LRU, cooldown'dan çıkmış, en eski lastUsedAt)
2. Rastgele şehir + yeni sticky session ID ile proxy uygulanır
3. Browser açılır (AdsPower fingerprint otomatik regenerate)
4. **Storage temizlenir** (cookies + cache + localStorage + IndexedDB)
5. **Filler phase**: 1-2 alakasız Google araması + 1 organik tıklama
   - Captcha çıkarsa CapSolver çöz, devam et
   - Çözülemezse session terk
6. **Target phase**: Her query için
   - Yeni tab → google.com → query → Enter
   - Captcha varsa CapSolver bekle (max 60s)
   - 3 sayfaya kadar tara, **exhausted olmayan** target domainleri tıkla
   - Landing'de 8-15s, scroll, kapat
7. Browser kapanır → profil 10 dk cooldown'a (failure ise 15 dk)

## Adaptive Target Tracking (`budget-state.json`)

Her gün sıfırlanan domain miss sayacı. Rakibin reklamı 3 ardışık aramada görünmedi → "bütçesi bitti" sayılıp gün sonuna kadar atlanır.

Tüm target domainler exhausted olunca ana loop "Tüm rakipler bütçelerini bitirdi" log'u atıp durur.

## Test

```bash
npm test
```

Pure logic testleri (`budget-tracker`, `proxy-rotation`).

## Profilleri Listele

```bash
npm run profiles
```

## Durdurma

- **Ctrl+C** ile manuel durdur (tıklama özeti basılır)
- `idle_timeout_minutes` süresince tıklama olmazsa otomatik dur
- `max_total_clicks` sayısına ulaşınca durur
- Tüm rakipler exhausted olunca otomatik durur

## Dosyalar

- `pilot-cookies.json` (gitignored, atıl) — eski pilot cookie sistemi (Model 0 kullanmıyor)
- `profiles.json` (gitignored) — profil kullanım istatistikleri
- `clicks.json` (gitignored) — domain başına kümülatif tıklama (filler dahil değil)
- `rankings.json` (gitignored) — organik sıralama geçmişi
- `budget-state.json` (gitignored) — adaptive tracker günlük state
