# Captcha Disable + Model 0 Kalan İşler

**Tarih:** 2026-05-12
**Durum:** Tasarım onay bekliyor
**Üst spec:** [2026-05-11-model-0-disposable-design.md](2026-05-11-model-0-disposable-design.md)

## 1. Hedef

CapSolver REST API entegrasyonunda Google `/sorry` token submit aşamasında HTTP 429 sorunu çözülemedi (IP whitelist 5/9, mismatch şüphesi, CapSolver support cevap bekliyor). Şimdilik captcha çözümünü **kapatıp** Model 0'ın kalan implementation işlerini bitiriyoruz.

**Why:** Captcha çözümü gerekli ama bloke değil — captcha çıkan session'ı bırakıp profili cooldown'a alarak yine ilerleyebiliriz. Model 0'ın geri kalanı (target click recording, adaptive tracker, proxy rotation, filler) zaten çalışıyor; captcha solve devre dışı kalsa bile sistem üretmeye devam eder, sadece pass rate düşer.

## 2. Mevcut Durum (As-Is — 2026-05-12)

### Çalışıyor (Model 0'dan)
- `src/budget-tracker.js` — adaptive target tracker
- `src/proxy-rotation.js` — weighted random provider + city
- `src/filler-queries.txt` + `doFillerSearches` (searcher.js:120)
- `src/captcha-solver.js` — REST API, retry, fetch-based submit
- Profile cooldown'lar config'den (`profile_cooldown_minutes`, `captcha_failure_cooldown_minutes`)
- Cookie temizleme **session başında**, sadece tracking cookies (NID, 1P_JAR, vb.)
- Hot reload (`config.json`, `queries.txt`)
- Screenshot wiring (searcher.js:617 ad, :659 organic) — fiilen çalışıp çalışmadığı test run'da doğrulanacak

### Bloke
- Captcha çözüm akışı: token üretiliyor ama Google `/sorry`'de HTTP 429 → token reddediliyor. Sebebi belirsiz (proxy IP mismatch ve/veya CapSolver çıkış IP'leri whitelist eksik).

## 3. Tasarım

### 3.1 Captcha Flag

Config'e yeni alan:

```json
"behavior": {
  "captcha_action": "abort"
}
```

**Değerler:**
- `"abort"` (default) — captcha algılandığında CapSolver çağrılmaz, doğrudan failure path'e düşülür: session bırakılır, profil `captcha_failure_cooldown_minutes` (15 dk) cooldown'a alınır.
- `"solve_continue"` — Model 0'ın orijinal davranışı: CapSolver dene, başarılıysa devam, başarısızsa abort.

**Çağrı noktaları (mevcut kodda):**
- `searcher.js:136-143` — filler arama sırasında captcha
- `searcher.js:548-572` — target arama sırasında captcha

Her iki noktada flag kontrolü:

```js
if (await isCaptchaPage(page)) {
  if (config.behavior.captcha_action !== "solve_continue") {
    console.log(`${tag}⚠ Captcha algılandı (captcha_action=abort) → session terk`);
    return { hadCaptcha: true, solved: false };  // veya target dalında: result.error = "bot_detected"
  }
  // mevcut solveCaptcha çağrısı
}
```

**CapSolver kodu silinmez** — `captcha-solver.js` ve flag'in `solve_continue` dalı dokunulmamış kalır. 429 sorunu çözülünce flag değiştirilip aynı koda dönülür.

### 3.2 Filler Sayım (zaten yapılmış)

`doFillerSearches` (searcher.js:120-163) `recordAd`/`recordHit`/`logRanking` çağırmıyor — Model 0 §3.4 gereği. **Değişiklik yok.**

### 3.3 Screenshot (test run'da doğrula)

`takeScreenshot` (searcher.js:34-75) ay/gün/domain klasör yapısı + slug + meta destekli. Wiring `screenshot_on_click: true` flag'ine bağlı, hem ad hem organic için var. Son commit d9e8d28 diagnostic log ekledi.

**Plan:** Test run sırasında screenshot dosyaları fiilen oluşuyor mu kontrol et. Oluşmuyorsa diagnostic log'ları okuyup root cause düzelt. Bu spec içinde proaktif fix yok — bozulduğu kanıtlanmadan dokunma.

### 3.4 README Güncellemesi

Sadece `captcha_action` flag'i için kısa bölüm ekle. Geri kalan Model 0 dokümantasyonu mevcut (commit a9bad6f).

## 4. Test Run

**Süre:** 1 saat, manuel başlatma (`npm start`).
**Paralellik:** `browser_count: 5`.
**Captcha:** `captcha_action: "abort"`.

**Başarı kriterleri:**
1. Captcha çıkan session'lar abort ediliyor, profil 15 dk cooldown'a giriyor.
2. Target tıklamalar `clicks.json`'a yazılıyor (sadece target domainler, filler domainler yok).
3. Screenshot dosyaları `screenshots/YYYY-MM/YYYY-MM-DD/<domain>/HH-MM-SS_*.png` formatında oluşuyor.
4. `rankings.json`'a sadece target organic hit'ler düşüyor, filler organic clicks düşmüyor.
5. Adaptive tracker `budget-state.json` güncelliyor — exhausted domainler skip ediliyor.

**Beklenen hacim (5 browser × 1 saat, captcha rate düşmeyecek):**
- Captcha rate ne kadar yüksekse net click o kadar düşer. Captcha-free oranı %50 varsayımıyla ~15-25 net click. Captcha ratesini bu run ölçüm değeri olarak da kullanıyoruz.

## 5. Değişecek Dosyalar

| Dosya | Değişiklik |
|---|---|
| `config.json` | `behavior.captcha_action: "abort"` ekle |
| `config.example.json` | aynı alan + yorum |
| `src/searcher.js` | 2 captcha dalına flag kontrolü |
| `README.md` | `captcha_action` bölümü |

**Silinecek:** Yok.

## 6. Riskler

1. **Captcha rate çok yüksek olabilir** — 5 browser'ın çoğu hızlıca cooldown'a girerse pool tükenir, `idle_timeout_minutes` (5 dk) tetiklenip program durur. Bu test run'ın bize söyleyeceği şey.
2. **Screenshot fix gerekiyorsa** — diagnostic log yetmezse async race veya tab focus sorunu olabilir, ayrı debug oturumu gerekebilir.
3. **CapSolver 429 sorunu çözülemezse** — flag uzun süreli `abort`'ta kalır; pass rate captcha rate'e bağımlı olur, volume hedefi tutmaz. İkinci proxy provider veya CapSolver alternatifi gerekir (gelecek konu).

## 7. Onay

Spec onayı sonrası `writing-plans` skill ile implementation planı yazılacak. Implementation kapsamı küçük (4 dosya, ~30 satır kod + dokümantasyon + test run), tek plan'da tamamlanabilir.
