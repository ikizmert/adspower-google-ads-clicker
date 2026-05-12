// Hyperbrowser debug — google.com.tr aç, pause et, sen live view'da manuel dene.
// Kullanım:
//   node scripts/hb-debug.js              → google.com.tr açar, pause
//   node scripts/hb-debug.js "url"        → verilen URL'i açar, pause
//
// Live view URL terminalde yazar — onu browser'da açıp manuel arama yap.
// Ctrl+C ile kapat.

const Hyperbrowser = require("@hyperbrowser/sdk").default || require("@hyperbrowser/sdk").Hyperbrowser;
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const cfgPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
const API_KEY = config.hyperbrowser && config.hyperbrowser.api_key;

if (!API_KEY) {
  console.error("✗ config.hyperbrowser.api_key eksik!");
  process.exit(1);
}

const targetUrl = process.argv[2] || "https://www.google.com.tr";

function randomSid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

(async () => {
  const hb = new Hyperbrowser({ apiKey: API_KEY });
  const hbCfg = config.hyperbrowser || {};
  const solveCaptchas = hbCfg.solve_captchas === true;
  const useStealth = hbCfg.use_stealth !== false;

  const sessionOpts = { solveCaptchas, useStealth, adblock: false };

  let proxyInfo = "yok";
  if (config.proxy && config.proxy.host) {
    const sid = randomSid();
    const scheme = config.proxy.type || "http";
    sessionOpts.useProxy = true;
    sessionOpts.proxyServer = `${scheme}://${config.proxy.host}:${config.proxy.port}`;
    sessionOpts.proxyServerUsername = `${config.proxy.base_user}_session-${sid}`;
    sessionOpts.proxyServerPassword = config.proxy.password;
    proxyInfo = `${sessionOpts.proxyServer} sid=${sid}`;
  }

  console.log(`[hb-debug] Session açılıyor (solveCaptchas=${solveCaptchas}, useStealth=${useStealth}, proxy=${proxyInfo})...`);
  const session = await hb.sessions.create(sessionOpts);

  console.log(`\n========================================`);
  console.log(`[hb-debug] Session ID: ${session.id}`);
  console.log(`\n📺 LIVE VIEW URL — browser'da aç:`);
  console.log(`\n${session.liveUrl}\n`);
  console.log(`========================================\n`);

  const browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint });

  // Cleanup on Ctrl+C
  let closing = false;
  process.on("SIGINT", async () => {
    if (closing) process.exit(0);
    closing = true;
    console.log(`\n[hb-debug] Session kapatılıyor...`);
    try { browser.disconnect(); } catch {}
    try { await hb.sessions.stop(session.id); } catch {}
    process.exit(0);
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    // IP doğrulama
    try {
      console.log(`[hb-debug] IP kontrolü...`);
      await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 15000 });
      const ipBody = await page.evaluate(() => document.body.innerText);
      console.log(`[hb-debug] Browser IP: ${ipBody}`);
    } catch (e) {
      console.log(`[hb-debug] IP check hatası: ${e.message.split("\n")[0]}`);
    }

    console.log(`[hb-debug] ${targetUrl}'e gidiliyor...`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`[hb-debug] Yüklendi: ${page.url().substring(0, 100)}`);

    console.log(`\n[hb-debug] ⏸  PAUSE — live view URL'inde manuel dene, Ctrl+C ile kapat`);
    console.log(`[hb-debug]    Hyperbrowser session sürecek (dakika başı maliyet işliyor)`);

    // Sonsuz bekleme — Ctrl+C ile sonlandırılır
    await new Promise(() => {});
  } catch (e) {
    console.error(`[hb-debug] Hata: ${e.message.split("\n")[0]}`);
    try { browser.disconnect(); } catch {}
    try { await hb.sessions.stop(session.id); } catch {}
    process.exit(1);
  }
})().catch((e) => {
  console.error(`[hb-debug] Kritik hata: ${e.message}`);
  process.exit(1);
});
