// Hyperbrowser quick test — captcha + ad serving validation
// Kullanım:
//   node scripts/hb-test.js "kuşadası çiçekçi"           → arama + reklam tespit (tıklama yok)
//   node scripts/hb-test.js "kuşadası çiçekçi" --click   → ilk reklamı tıkla
//
// API key config.json'daki hyperbrowser.api_key alanından okunur.
// Screenshot'lar repo köküne yazılır (hb-test-*.png).

const Hyperbrowser = require("@hyperbrowser/sdk").default || require("@hyperbrowser/sdk").Hyperbrowser;
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const cfgPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
const API_KEY = config.hyperbrowser && config.hyperbrowser.api_key;

if (!API_KEY || API_KEY.startsWith("hb_6fb5fb0de30a75c2b")) {
  console.error("✗ config.hyperbrowser.api_key eksik ya da eski (leaked) key. Hyperbrowser dashboard'dan yeni key üret ve config.json'a yaz.");
  process.exit(1);
}

const query = process.argv[2] || "kuşadası çiçekçi";
const shouldClick = process.argv.includes("--click");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function isCaptchaPage(page) {
  try {
    const url = page.url();
    if (url.includes("/sorry") || url.includes("captcha")) return true;
    const html = await page.content();
    return html.includes("g-recaptcha") || html.includes("recaptcha") || html.includes("unusual traffic");
  } catch { return false; }
}

(async () => {
  console.log(`[hb-test] query: "${query}" | click: ${shouldClick}`);

  const hb = new Hyperbrowser({ apiKey: API_KEY });
  const hbCfg = config.hyperbrowser || {};
  // Free plan: solveCaptchas + hyperbrowser'ın kendi proxy havuzu kapalı.
  // Ama external (bring-your-own) proxy serbest olabilir.
  const solveCaptchas = hbCfg.solve_captchas === true;
  const useProxy = hbCfg.use_proxy === true; // default false — paid feature

  const useStealth = hbCfg.use_stealth !== false; // default true
  const sessionOpts = { solveCaptchas, useStealth, adblock: false };

  // BYO external proxy — doğru SDK formatı: flat proxyServer/Username/Password + useProxy: true
  // (Free plan'da useProxy: true bloklu, paid plan gerekli)
  let externalProxyInfo = "yok";
  if (config.proxy && config.proxy.host) {
    const randomSid = () => {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let s = "";
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    };
    const sid = randomSid();
    const scheme = config.proxy.type || "http";
    sessionOpts.useProxy = true;
    sessionOpts.proxyServer = `${scheme}://${config.proxy.host}:${config.proxy.port}`;
    sessionOpts.proxyServerUsername = `${config.proxy.base_user}_session-${sid}`;
    sessionOpts.proxyServerPassword = config.proxy.password;
    externalProxyInfo = `${sessionOpts.proxyServer} sid=${sid}`;
  } else {
    sessionOpts.useProxy = useProxy;
  }
  console.log(`[hb-test] Session açılıyor (solveCaptchas=${solveCaptchas}, useStealth=${useStealth}, externalProxy=${externalProxyInfo})...`);

  const session = await hb.sessions.create(sessionOpts);
  console.log(`[hb-test] Session ID: ${session.id}`);
  if (session.liveUrl) console.log(`[hb-test] Live view: ${session.liveUrl}`);

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    // IP doğrulama — external proxy çalışıyor mu?
    try {
      console.log(`[hb-test] IP kontrol ediliyor (api.ipify.org)...`);
      await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 15000 });
      const ipBody = await page.evaluate(() => document.body.innerText);
      console.log(`[hb-test] Browser IP: ${ipBody}`);
    } catch (e) {
      console.log(`[hb-test] IP check hatası: ${e.message.split("\n")[0]}`);
    }

    console.log(`[hb-test] Google.com.tr'e gidiliyor...`);
    await page.goto("https://www.google.com.tr", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);

    if (await isCaptchaPage(page)) {
      console.log(`[hb-test] ⚠ Google.com'da captcha — hyperbrowser çözmesini bekliyoruz (60s)...`);
      const captchaUrl = page.url();
      for (let i = 0; i < 12; i++) {
        await sleep(5000);
        if (!(await isCaptchaPage(page))) {
          console.log(`[hb-test] ✓ Captcha ${(i + 1) * 5}s'de çözüldü, URL: ${page.url().substring(0, 80)}`);
          break;
        }
      }
      if (await isCaptchaPage(page)) {
        console.log(`[hb-test] ✗ Captcha 60s'de çözülmedi. Hyperbrowser solveCaptchas çalışmıyor olabilir.`);
        await page.screenshot({ path: path.join(__dirname, "..", "hb-test-captcha.png"), fullPage: false }).catch(() => {});
        console.log(`[hb-test] Screenshot: hb-test-captcha.png`);
        return;
      }
    } else {
      console.log(`[hb-test] ✓ Google.com'da captcha yok`);
    }

    console.log(`[hb-test] Search input aranıyor...`);
    const input = await page.$('textarea[name="q"], input[name="q"]');
    if (!input) {
      console.log(`[hb-test] ✗ Search input bulunamadı`);
      await page.screenshot({ path: path.join(__dirname, "..", "hb-test-no-input.png"), fullPage: false }).catch(() => {});
      return;
    }

    console.log(`[hb-test] "${query}" yazılıyor + Enter...`);
    await input.click();
    await sleep(400);
    await input.type(query, { delay: 100 });
    await sleep(1000);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.keyboard.press("Enter"),
    ]);
    await sleep(2000);

    console.log(`[hb-test] Search URL: ${page.url().substring(0, 100)}`);

    if (await isCaptchaPage(page)) {
      console.log(`[hb-test] ⚠ Search sonrası captcha — bekleniyor (60s)...`);
      for (let i = 0; i < 12; i++) {
        await sleep(5000);
        if (!(await isCaptchaPage(page))) {
          console.log(`[hb-test] ✓ Captcha ${(i + 1) * 5}s'de çözüldü`);
          break;
        }
      }
      if (await isCaptchaPage(page)) {
        console.log(`[hb-test] ✗ Search captcha 60s'de çözülmedi.`);
        await page.screenshot({ path: path.join(__dirname, "..", "hb-test-captcha.png"), fullPage: false }).catch(() => {});
        return;
      }
    }

    // Reklam tespiti
    const ads = await page.$$("a[data-pcu]");
    console.log(`[hb-test] Sayfada ${ads.length} reklam (a[data-pcu]) bulundu`);

    if (ads.length === 0) {
      console.log(`[hb-test] ⚠ Hiç reklam yok — bu query için Google bu IP'ye ad göstermiyor`);
      await page.screenshot({ path: path.join(__dirname, "..", "hb-test-no-ads.png"), fullPage: false }).catch(() => {});
      console.log(`[hb-test] Screenshot: hb-test-no-ads.png`);
      return;
    }

    // İlk birkaç reklamın bilgisini yazdır
    const adList = [];
    for (let i = 0; i < Math.min(5, ads.length); i++) {
      const info = await ads[i].evaluate(el => ({
        href: (el.href || "").substring(0, 80),
        pcu: el.getAttribute("data-pcu"),
        text: (el.innerText || "").substring(0, 60).replace(/\s+/g, " "),
      })).catch(() => null);
      if (info) adList.push(info);
    }
    console.log(`[hb-test] İlk reklamlar:`);
    adList.forEach((a, i) => console.log(`  ${i + 1}. domain=${a.pcu} | "${a.text}"`));

    await page.screenshot({ path: path.join(__dirname, "..", "hb-test-search.png"), fullPage: false }).catch(() => {});
    console.log(`[hb-test] Screenshot: hb-test-search.png`);

    if (shouldClick) {
      console.log(`[hb-test] İlk reklam tıklanıyor...`);
      const targetAd = ads[0];
      const adInfo = await targetAd.evaluate(el => el.getAttribute("data-pcu"));
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {}),
        targetAd.click(),
      ]);
      await sleep(4000);
      console.log(`[hb-test] ✓ Landing: ${page.url().substring(0, 100)}`);
      console.log(`[hb-test] Hedef domain: ${adInfo}`);
      await page.screenshot({ path: path.join(__dirname, "..", "hb-test-landing.png"), fullPage: false }).catch(() => {});
      console.log(`[hb-test] Screenshot: hb-test-landing.png`);
    } else {
      console.log(`[hb-test] (--click flag yok, tıklama atlandı)`);
    }
  } catch (e) {
    console.error(`[hb-test] ✗ Hata: ${e.message.split("\n")[0]}`);
  } finally {
    try { if (browser) browser.disconnect(); } catch {}
    try { await hb.sessions.stop(session.id); } catch {}
    console.log(`[hb-test] Session kapatıldı`);
  }
})().catch(e => {
  console.error(`[hb-test] Kritik hata: ${e.message}`);
  process.exit(1);
});
