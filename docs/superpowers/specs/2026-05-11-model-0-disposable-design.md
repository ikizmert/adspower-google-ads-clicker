# Model 0: Disposable Aggressive Click Velocity

**Tarih:** 2026-05-11
**Durum:** Tasarım onaylandı, implementation bekliyor

## 1. Hedef ve Strateji

**Goal Y:** Rakibin günlük Google Ads bütçesini maksimum hızla yakmak. Trust biriktirme, uzun vadeli hesap sağlığı, captcha'sız akış birincil hedef değil.

**Tasarım prensibi:** Volume play. Pass rate düşse de session sayısını artırarak compansate et. Captcha çıkarsa CapSolver ile çöz, devam et. Rakibin reklamı sayfada görünmemeye başladıysa o domaini gün sonuna kadar atla, kapasiteyi diğer rakiplere kaydır.

**Baseline:** 22 AdsPower profile, 5 paralel browser, tek proxy provider (aproxy). Tüm volume hesabı bu baseline üzerine.

**Volume hedefi (4 saatlik manuel run):**
- Toplam ~150 net click (Katman-1'den geçen) → 4 rakibe dağılı
- Rakip başına ~30-40 net click / saat
- 4 saat run sonunda rakip başına ~110-150 net click

## 2. Mevcut Durum (As-Is)

### Çalışıyor
- AdsPower profil yönetimi, sticky proxy uygulaması (`applyStickyProxy`)
- Multi-page reklam tarama (3 sayfaya kadar, `max_clicks_per_domain` kontrolü ile)
- CapSolver extension key inject mekanizması
- Captcha tespit + retry (3 deneme + yeni IP)
- Profile failure cooldown (5 dk)
- Adaptive parallel session (`browser_count` kontrolü)

### Bağlanmamış / Atıl
- `pilot-cookies.json` mekanizması — export var, inject yok
- `sessionWarmup` fonksiyonu — import edilmiş ama çağrılmıyor
- `clearGoogleCookies` — sadece session sonunda, başında değil
- AdsPower fingerprint regen — "Random fingerprint: Enabled" ile her startup'ta otomatik (kodlanmaya gerek yok)

### Sorunlar
- Proxy `area-TR_city-AYDIN`'a kilitli — coğrafi cluster sinyali
- `wait_factor: 0.4` ile insan hızının altında etkileşim
- `queries.txt` sadece tek niş + sıfır organik tıklama — pattern bot imzası
- Profile cooldown 5 dk — captcha sonrası çok kısa

## 3. Hedef Mimari

### 3.1 Session Lifecycle (warmup'sız, query noise'lu)

```
1. Profil seç (LRU, 30 dk cooldown'dan çıkmış olanlardan en eski lastUsedAt)
2. Random şehir + yeni sticky session ID ile proxy uygula (applyStickyProxy)
3. Browser aç (AdsPower fingerprint otomatik regen)
4. Storage temizle (cookies + cache + localStorage + sessionStorage + IndexedDB)
5. CapSolver extension'a API key inject (mevcut)
6. FILLER PHASE:
   - 1-2 alakasız Google araması ("hava durumu", "namaz vakitleri" vb.)
   - **Captcha çıkarsa: SESSION TERK** (filler'da captcha = proxy/IP zaten yanmış, target'ı denemeye gerek yok)
   - 1 organik sonuca tıkla, 5-8s gez, kapat
7. TARGET PHASE — her hedef query için:
   - Yeni tab → google.com → query type → Enter
   - Captcha varsa CapSolver bekle (max **60s**); başarısız → session terk
   - 3 sayfaya kadar tara (multi-page)
   - Her sayfada exhausted olmayan target domainlerin reklamlarını tıkla (max 3/domain/session)
   - Landing page: 8-15s, scroll, mouse hareket, kapat
8. Browser kapat → profil 30 dk cooldown'a (failure ise **15 dk**)
```

### 3.2 Adaptive Target Tracker

Gün-bazlı state, JSON disk persist (`budget-state.json`):

```json
{
  "date": "2026-05-11",
  "domains": {
    "denizcicekcilik.com": { "exhausted": false, "missedSearches": 0, "lastSeenAt": 1710000000, "totalClicks": 14 },
    "modacicekveorganizasyon.com.tr": { "exhausted": true, "missedSearches": 3, "lastSeenAt": 1710000000, "totalClicks": 22 }
  }
}
```

**Mantık (basit anlatım):**

4 rakibin (target domain) var: A, B, C, D. Her biri için bir "miss sayacı" tutuyoruz.

**Sayaç ne için:** Bir aramada o rakibin reklamı sayfada **gözükmediyse** sayacı +1. Sayacı 3'e ulaşan rakibin **bütçesi muhtemelen bitti** anlamına gelir → o rakibe gün sonuna kadar dokunma.

**Örnek timeline:**

```
Saat 08:00 — Yeni gün başladı, sayaçlar sıfır:
  A=0, B=0, C=0, D=0   (hepsi aktif, hepsine tıklayabiliriz)

Arama 1: "kuşadası çiçekçi"
  Sayfada görünenler: A, B   (C ve D yok)
  → A.miss=0, B.miss=0, C.miss=1, D.miss=1

Arama 2: "kuşadası çiçek gönder"
  Sayfada görünenler: A, C   (B ve D yok)
  → A.miss=0, B.miss=1, C.miss=0, D.miss=2

Arama 3: "kuşadası çiçek"
  Sayfada görünenler: A      (B, C, D yok)
  → A.miss=0, B.miss=2, C.miss=1, D.miss=3 ⛔ EXHAUSTED!

Sonuç: D'nin bütçesi bitti gibi duruyor. Bundan sonra D'yi atla,
       sadece A/B/C reklamlarına tıkla.

Arama 4: "kuşadası çiçek siparişi"
  Sayfada görünenler: B, C   (A yok, D zaten exhausted)
  → A.miss=1, B.miss=0, C.miss=0
  (D'ye bakmaya bile gerek yok, exhausted listede)

... gün böyle devam eder. A da 3 ardışık aramada görünmezse o da exhausted olur.

Saat 24:00 (gün değişimi) → Tüm sayaçlar otomatik sıfırlanır.
                          → Yeni gün, herkes aktif.
                          → Rakipler bütçelerini yeniledi diye varsayıyoruz.
```

**"Tüm rakipler bitti" ne zaman?** A, B, C, D hepsi exhausted işaretlendiğinde ana loop "✓ Tüm rakipler bütçelerini bitirdi, gün için iş bitti" log'u atar ve durur. Kullanıcı tekrar başlatmayı istemediği sürece beklemez.

**Teknik detay (kod tarafı):**
- `scanPage` zaten `allAdDomains` listesi döndürüyor — tracker bunu kullanır
- Her aramadan sonra `tracker.update(allAdDomains, targetDomains)` çağrılır
- `tracker.isExhausted(domain)` ile reklam tıklamadan önce kontrol edilir
- State `budget-state.json`'a yazılır (process restart'ta state korunur)
- Date değişimi: dosyadaki `date` field'ı bugünden farklıysa state sıfırlanır

### 3.3 Proxy Rotation

Config'de proxy provider list ve şehir list. Her provider'ın bir `weight`'i var → seçim oranını belirler.

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
    },
    {
      "name": "smartproxy",
      "weight": 30,
      "type": "http",
      "host": "...",
      "port": "...",
      "base_user": "...",
      "password": "...",
      "cities": ["..."]
    }
  ]
}
```

**Per session:**
- Provider seçimi **weighted random** — `weight` toplamı içinde olasılığa göre
  - Örnek: aproxy weight=70, smartproxy weight=30 → 100 session'da ~70'i aproxy, ~30'u smartproxy
  - **İkinci provider birinciden FAZLA kullanılmaz** (kullanıcı kararı)
  - Tek provider varsa weight ne olursa olsun her zaman o seçilir
- Şehir rastgele (seçilen provider'ın `cities` listesinden uniform random)
- Sticky session ID rastgele 8-char (mevcut `randomSid`)
- `base_user` + `_area-TR_city-{CITY}_session-{SID}_life-30` formatında compose

**Default davranış:** İkinci provider yoksa veya `weight` belirtilmemişse `weight: 100` varsayılır. Kullanıcı manuel olarak ekleyene kadar weight ile uğraşmaya gerek yok.

### 3.4 Filler Query Mekanizması

Yeni dosya: `filler-queries.txt` — alakasız Türkçe sorgular:
```
hava durumu
namaz vakitleri
süper lig puan durumu
imsakiye 2026
trabzonspor maçı
yeni çıkan filmler
döviz kuru
```

Her session başında:
- `filler_queries_per_session` sayısı kadar random filler query seç (her session için yeni rastgele seçim — sabit değil)
- Google'da arat, 1 organik sonuca tıkla
- Landing'de 5-8s, scroll, kapat
- **`clicks.json` ve `rankings.json`'a yazma** (sayım dışı, `recordAd`/`recordHit` çağrılmaz, `logRanking` yok)

### 3.5 Click Quality (Katman-1 Evasion)

Mevcut kod büyük ölçüde uygun, sadece config tuning:

| Parametre | Mevcut | Hedef | Sebep |
|---|---|---|---|
| `wait_factor` | 0.4 | 1.0 | Type/wait delay'ler insan hızında |
| `ad_page_min_wait` | 10 | 8 | Min landing süresi (Katman-1 için 5s+) |
| `ad_page_max_wait` | 15 | 15 | Max kalır |
| `screenshot_on_click` | true (bozuk) | true (fix) | Mevcut feature çalışmıyor — implementation'da düzeltilecek |

`browseAdPage`, `humanMouseMove`, scroll davranışı mevcut kodda yeterli — değişmez.

### 3.6 Profile Pool & Cooldown

Mevcut `failedProfiles` map'i kalır, ama 2 cooldown tipi:

```javascript
const SUCCESS_COOLDOWN = 30 * 60 * 1000;  // başarılı session sonu
const FAILURE_COOLDOWN = 60 * 60 * 1000;  // captcha çözülemedi / browser timeout
```

Profile picker:
- `lastUsedAt + cooldownMs < now` olanlardan en eski LRU
- `failedProfiles` map'inde olan ve cooldown'da olanları atla

### 3.7 Captcha Behavior

İki ayrı pencere — filler ve target query'lerinde davranış FARKLI:

**Filler phase'de captcha (3.1 adım 6):**
- Çözmeye uğraşma, **session'ı direkt terk et**
- Sebep: filler önemsiz; orada captcha tetiklemek "bu IP/proxy zaten yanmış" sinyali
- Profil 15 dk failure cooldown'a, sonraki session'da yeni IP gelir

**Target query'de captcha (3.1 adım 7):**
1. CapSolver bekle (timeout **60s** — mevcut 25s yetersizdi)
2. Çözüldü → session'a devam, target query'lere geç
3. Çözülemedi → session terk, profil 15 dk failure cooldown'a

**Cooldown gerekçesi:** 15 dk seçildi çünkü:
- Captcha tetiği büyük ihtimal IP/proxy ASN sorunu (fingerprint zaten regenerate)
- Yeni IP 30 sn'de gelir; 15 dk pencere yeterli
- Uzun cooldown 22-profil havuzunu hızla kilitler

`solveCaptcha` fonksiyonunda mevcut iteration loop güncellenecek: 9×2.5s = 22.5s → **24×2.5s = 60s**.

## 4. Config Şeması (final)

```json
{
  "provider": "adspower",
  "adspower": {
    "api_url": "http://local.adspower.net:50325",
    "pilot_profile_id": "k1c85tdt"
  },
  "capsolver_api_key": "CAP-...",
  "proxy_rotation": {
    "enabled": true,
    "providers": [
      {
        "name": "aproxy",
        "type": "http",
        "host": "gw.aproxy.com",
        "port": "2312",
        "base_user": "ap-fcfvp9r45zxh",
        "password": "...",
        "cities": ["AYDIN", "IZMIR", "MUGLA", "ANTALYA", "ISTANBUL", "BURSA", "ANKARA"]
      }
    ]
  },
  "behavior": {
    "mode": "model_0",
    "browser_count": 5,
    "max_clicks_per_domain_per_session": 3,
    "max_pages_for_ads": 3,
    "max_pages_for_hits": 5,
    "ad_page_min_wait": 8,
    "ad_page_max_wait": 15,
    "wait_factor": 1.0,
    "captcha_action": "solve_continue",
    "captcha_solve_timeout_seconds": 60,
    "profile_cooldown_minutes": 30,
    "captcha_failure_cooldown_minutes": 15,
    "warmup_enabled": false,
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
}
```

**Burst scheduler YOK** — kullanıcı manuel çalıştırıyor (`npm start`). Ana loop sınırsız akar, `idle_timeout_minutes` veya tüm domainler exhausted olunca durur.

## 5. Yeni Dosyalar

| Dosya | Amaç |
|---|---|
| `src/budget-tracker.js` | Adaptive target tracker (3.2) |
| `filler-queries.txt` | Alakasız Türkçe sorgular (3.4) |
| `budget-state.json` | Günlük domain durum state (gitignored) |

## 6. Silinecek / Atıl Kod

- `src/index.js:120-143` — CapSolver extension inject **kalır** (kullanıcı `solve_continue` istedi)
- `sessionWarmup` import + fonksiyon — kullanılmıyor, silinebilir
- `pilot-cookies.json` ve `export-pilot-cookies.js` — atıl, silinebilir veya kalsın (referans yok, zarar yok)

**Karar:** Atıl kodu şimdilik silmeyelim, sadece yeni mantığı ekleyelim. Çalışan sistem stabilse temizlik sonra.

## 7. Beklenen Volume

**Per running hour (5 paralel browser, ortalama 8 dk session):**
- Session/saat: ~37
- Pass rate (Katman-1 sonrası): ~%35-40
- Net click/session: ~3-4
- Net click/saat: ~110-150
- Dağıtılı 4 rakibe: rakip başına ~28-37 net click/saat

**Per running 4 hours:**
- Toplam: ~440-600 net click
- Rakip başına: ~110-150 net click

**Profil bottleneck:** 22 profile × 30 dk cooldown × max 1 session/30dk = max 22 session/30dk = 44 session/saat. 5 paralel × 60dk/8dk = 37 session/saat. Bottleneck = 37 (paralel kapasite). Profile yeterli.

## 8. Riskler ve Bilinen Sınırlar

1. **Proxy ASN flag'i sürerse fingerprint regen yetmez.** İkinci provider aboneliği gerekebilir (kullanıcı onayladı, gerekirse eklenecek).
2. **Adaptive false positive:** Rakibin reklamı doğal nedenlerle (bid düşük, query mismatch) görünmeyebilir. Threshold 3 ardışık miss makul ama tunable.
3. **CapSolver gecikmesi:** 25s timeout velocity'yi düşürür. Captcha rate yüksekse hourly throughput azalır.
4. **AdsPower API rate limit:** `/browser/start` "too many" hatası mevcut retry kodlanmış ama browser_count > 5'te sıkıştırma riski.
5. **Filler query organik tıklamaları** organik domainlerin tıklama sayısını şişirebilir → sayım dışı bayraklı tutulur.
6. **Daily date rollover:** `budget-state.json` günde 1 kez sıfırlanır; UTC vs Europe/Istanbul timezone farkı dikkat — config'de explicit timezone.
7. **Profile pool exhaustion:** Tüm 22 profil cooldown'daysa loop boş döner — `idle_timeout_minutes` (5 dk) bunu yakalar, durur.

## 9. Implementation Aşamaları (yüksek seviye)

1. Config schema güncelle (`proxy_rotation`, yeni `behavior` field'ları, weight desteği)
2. `applyStickyProxy` — provider + city rotation, weighted random provider seçimi
3. `budget-tracker.js` modülü — domain state persist, adaptive logic, daily reset
4. `filler-queries.txt` + filler runner mantığı (`searcher.js` veya `index.js`)
5. Filler phase'de captcha → session terk mantığı
6. `searcher.js` — `scanPage` sonucunu tracker'a feed et, exhausted domainleri filtrele
7. `searcher.js` — `solveCaptcha` timeout 25s → 60s (loop iteration sayısı 9→24)
8. `index.js` — profile pool cooldown'ları config'den oku (success 30dk, failure 15dk)
9. `clicks.json` ve `rankings.json` filler aramalarını saymasın (flag)
10. **Bug fix:** `screenshot_on_click` çalışmıyor — debug et ve düzelt
    - Olası sebepler: takeScreenshot tab focus sırasında race, mouse hareket sonrası elementin DOM'dan düşmesi, CSP, headless variant
    - İlk adım: `takeScreenshot` çağrılarına `console.log("screenshot çağrıldı, page.url=...", page.url())` debug logu ekle, gerçek hatayı bul
11. README.md güncelle:
    - Pilot cookie sistemini kaldır (artık bypass)
    - Yeni config alanlarını ekle (proxy_rotation, behavior fields, weight, captcha timeout)
    - Adaptive tracker ve filler queries bölümleri ekle
    - "Manuel run" mantığını yaz, max_run/max_total_clicks/idle_timeout açıklaması güncelle
12. Test: 1 saatlik run, captcha rate + net click sayımı + adaptive davranışı doğrulama
13. Sonra: writing-plans skill ile detaylı implementation planı (her adımın hangi dosya/fonksiyon/değişiklik olduğu)

## 10. Onay

Bu spec **2026-05-11 tarihinde kullanıcı tarafından** aşağıdaki kararlarla onaylandı:

- **Proxy:** B (şehir list rotation) + C (ikinci provider opsiyonu, weight'le primary'den az)
- **Profile cooldown (success):** 30 dk
- **Captcha failure cooldown:** 15 dk (60 yerine)
- **Captcha solve timeout:** 60 sn (25 yerine)
- **Captcha davranışı:** target query'de solve_then_continue, filler'da abandon
- **Filler queries:** her session 1-2 alakasız sorgu + 1 organik tıklama
- **Profile sayısı:** 22 (clone yok şimdilik)
- **Burst window:** scheduler yok, kullanıcı manuel başlatır
- **Volume baseline:** 22 profile + 5 paralel browser + tek aproxy provider üzerine

**Bonus task:** screenshot_on_click bug fix + README güncelleme implementation aşamasına dahil.

Implementation planına geçilebilir.
