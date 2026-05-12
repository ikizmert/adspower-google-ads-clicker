// Hyperbrowser debug — runner-model-2'nin setup'ını birebir taklit eder, sonra google.com'da pause.
// Amaç: setup adımlarından biri captcha tetikliyor mu görmek.
// Kullanım: node scripts/hb-debug-flow.js

const Hyperbrowser = require("@hyperbrowser/sdk").default || require("@hyperbrowser/sdk").Hyperbrowser;
const puppeteer = require("puppeteer-core"); // runner-model-2 ile aynı — stealth plugin yok
const fs = require("fs");
const path = require("path");

const cfgPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
const API_KEY = config.hyperbrowser && config.hyperbrowser.api_key;

function randomSid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function isCaptchaPage(page) {
  try {
    const url = page.url();
    if (url.includes("/sorry") || url.includes("captcha")) return true;
    const html = await page.content();
    return html.includes("g-recaptcha") || html.includes("unusual traffic");
  } catch { return false; }
}

(async () => {
  const hb = new Hyperbrowser({ apiKey: API_KEY });
  const hbCfg = config.hyperbrowser || {};
  const sessionOpts = {
    solveCaptchas: hbCfg.solve_captchas === true,
    useStealth: hbCfg.use_stealth !== false,
    adblock: false,
  };

  // BYO proxy
  if (config.proxy && config.proxy.host) {
    const sid = randomSid();
    const scheme = config.proxy.type || "http";
    sessionOpts.useProxy = true;
    sessionOpts.proxyServer = `${scheme}://${config.proxy.host}:${config.proxy.port}`;
    sessionOpts.proxyServerUsername = `${config.proxy.base_user}_session-${sid}`;
    sessionOpts.proxyServerPassword = config.proxy.password;
    console.log(`[step 0] Sticky proxy sid=${sid}`);
  }

  console.log(`[step 1] Session açılıyor (runner-model-2 ile aynı setup)...`);
  const session = await hb.sessions.create(sessionOpts);

  console.log(`\n========================================`);
  console.log(`Session ID: ${session.id}`);
  console.log(`\n📺 LIVE VIEW URL:`);
  console.log(`${session.liveUrl}\n`);
  console.log(`========================================\n`);

  const browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint });

  // Ctrl+C cleanup
  let closing = false;
  process.on("SIGINT", async () => {
    if (closing) process.exit(0);
    closing = true;
    console.log(`\n[cleanup] Session kapatılıyor...`);
    try { browser.disconnect(); } catch {}
    try { await hb.sessions.stop(session.id); } catch {}
    process.exit(0);
  });

  try {
    // STEP 2: closeExtraTabs (runner-model-2 ilk adımlarından)
    console.log(`[step 2] closeExtraTabs...`);
    const newTab = await browser.newPage();
    const pages = await browser.pages();
    for (const p of pages) {
      if (p !== newTab) await p.close().catch(() => {});
    }
    console.log(`[step 2] OK — about:blank kaldı`);

    // STEP 3: IP check (runner'ın yaptığı)
    console.log(`[step 3] IP check (api.ipify.org)...`);
    await newTab.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 15000 });
    const ipBody = await newTab.evaluate(() => document.body.innerText);
    console.log(`[step 3] Browser IP: ${ipBody}`);
    if (await isCaptchaPage(newTab)) {
      console.log(`[step 3] ⚠ Captcha ZATEN var (IP check'ten sonra)`);
    } else {
      console.log(`[step 3] ✓ Captcha yok`);
    }

    // STEP 4: browser.newPage() + goto google.com.tr (doSearch'ün yaptığı)
    console.log(`[step 4] Yeni tab + google.com.tr...`);
    const searchPage = await browser.newPage();
    await searchPage.goto("https://www.google.com.tr", { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`[step 4] URL: ${searchPage.url().substring(0, 80)}`);
    if (await isCaptchaPage(searchPage)) {
      console.log(`[step 4] ⚠ CAPTCHA — google.com.tr açılır açılmaz`);
    } else {
      console.log(`[step 4] ✓ Captcha yok, sayfa açıldı`);
    }

    console.log(`\n⏸  PAUSE — şimdi sen Live View'da test et:`);
    console.log(`   1. Arama kutusuna tıkla, "kuşadası çiçekçi" yaz, Enter`);
    console.log(`   2. Captcha çıkıyor mu izle`);
    console.log(`   3. Bitince Ctrl+C\n`);

    await new Promise(() => {});
  } catch (e) {
    console.error(`[hata] ${e.message.split("\n")[0]}`);
    try { browser.disconnect(); } catch {}
    try { await hb.sessions.stop(session.id); } catch {}
    process.exit(1);
  }
})().catch((e) => {
  console.error(`[kritik] ${e.message}`);
  process.exit(1);
});
