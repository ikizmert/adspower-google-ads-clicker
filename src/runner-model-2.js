// Model 2: Simple aggressive runner — hyperbrowser cloud sessions, no warmup, no state machine.
// Her session: open → search → click → close → bir sonraki random query'e geç.

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const { config } = require("./config");
const { searchAndClick, closeExtraTabs, enableImageBlocking } = require("./searcher");
const tracker = require("./profile-tracker");
const clickCounter = require("./click-counter");
const { state: stats } = require("./stats");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runOneSession(provider, queryDef, sessionLabel) {
  // Anonymous "profile" — hyperbrowser her session zaten fresh, profile concept yok
  const profileId = `hb-${sessionLabel.replace("#", "")}`;
  let browser, sessionInfo;

  try {
    sessionInfo = await provider.openBrowser(profileId);
    browser = await puppeteer.connect({ browserWSEndpoint: sessionInfo.wsEndpoint });
  } catch (e) {
    const msg = e.message.split("\n")[0];
    console.error(`[${sessionLabel}] Session açılamadı: ${msg}`);
    // Hyperbrowser concurrency limit (free plan = 1) — runner'a sinyal
    const limitReached = /maximum number of active sessions/i.test(msg);
    return { clicked: 0, hits: 0, adsFound: 0, error: limitReached ? "concurrency_limit" : "open_failed" };
  }

  let result = null;
  try {
    if (config.behavior.block_images) {
      await enableImageBlocking(browser).catch(() => {});
    }
    await closeExtraTabs(browser).catch(() => {});

    // IP doğrulama (BYO proxy gerçekten çalışıyor mu — Mac/dashboard üst panel "Proxy: US" yanıltıcı olabilir)
    if (config.behavior.log_browser_ip !== false) {
      try {
        const pages = await browser.pages();
        const ipPage = pages[0] || (await browser.newPage());
        await ipPage.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 10000 });
        const ipBody = await ipPage.evaluate(() => document.body.innerText);
        const ipMatch = /"ip":"([^"]+)"/.exec(ipBody);
        if (ipMatch) console.log(`[${sessionLabel}]   Browser IP: ${ipMatch[1]}`);
      } catch {}
    }

    // Tek query, tek session — agresif turnover
    result = await searchAndClick(
      browser,
      queryDef.search,
      queryDef.adDomains,
      queryDef.hitDomains,
      sessionLabel,
      {}, // sessionAdClicks — boş, max_clicks_per_domain zaten 1
      null, // budget tracker yok
      null  // proxyApplied yok (captcha_action=abort veya hyperbrowser solveCaptchas)
    ).catch((e) => {
      console.error(`[${sessionLabel}] searchAndClick hatası: ${e.message.split("\n")[0]}`);
      return null;
    });
  } finally {
    try { browser.disconnect(); } catch {}
    try { await provider.closeBrowser(profileId); } catch {}
  }

  // Stats güncelle
  stats.completed++;
  const adsFound = result?.totalAdsOnPage || 0;
  const clicked = result?.ads || 0;
  const hits = result?.hits || 0;
  if (clicked === 0) stats.totalFailed++;

  // Recording (tracker no_ads_streak için, dashboard'a kümülatif counter için)
  tracker.recordSession(profileId, adsFound);

  console.log(`[${sessionLabel}] Bitti | tıklanan: ${clicked} | reklam: ${adsFound}${result?.error ? " | " + result.error : ""}`);

  if (result?.rankings?.length > 0) {
    for (const r of result.rankings) {
      console.log(`[${sessionLabel}]   "${queryDef.search}" → ${r.domain}: Sayfa ${r.page}, Sıra ${r.position} (genel: ${r.globalPosition})`);
    }
  }
  for (const nf of (result?.notFound || [])) {
    console.log(`[${sessionLabel}]   "${queryDef.search}" → ${nf}: bulunamadı`);
  }

  return { clicked, hits, adsFound, error: result?.error };
}

async function runModel2(provider, parsedQueries) {
  const concurrency = config.behavior.concurrency || 5;
  const maxRun = config.behavior.max_run || 0;
  const maxTotalClicks = config.behavior.max_total_clicks || 0;
  const idleTimeoutMs = (config.behavior.idle_timeout_minutes || 0) * 60 * 1000;
  const unlimited = !maxRun || maxRun <= 0;

  console.log(`Mode: model_2 (simple/aggressive) | Concurrent: ${concurrency} | Session: ${unlimited ? "sınırsız" : maxRun}` +
    (maxTotalClicks ? ` | Max click: ${maxTotalClicks}` : "") +
    (idleTimeoutMs ? ` | Idle timeout: ${config.behavior.idle_timeout_minutes}dk` : ""));
  console.log(`Query: ${parsedQueries.length} | Bekleme: ${config.behavior.ad_page_min_wait}-${config.behavior.ad_page_max_wait}s\n`);

  stats.maxRun = unlimited ? Infinity : maxRun;
  let lastClickTime = Date.now();
  let lastActivitySnapshot = stats.totalClicked + stats.totalHits;
  let sessionCounter = 0;

  const active = new Map();
  let concurrencyBackoffUntil = 0; // Hyperbrowser limit yedikten sonra backoff

  function shouldStop() {
    const totalActivity = stats.totalClicked + stats.totalHits;
    if (totalActivity > lastActivitySnapshot) {
      lastActivitySnapshot = totalActivity;
      lastClickTime = Date.now();
    }
    if (maxTotalClicks > 0 && stats.totalClicked >= maxTotalClicks) {
      stats.stopReason = `Max tıklama (${maxTotalClicks}) ulaşıldı`;
      return true;
    }
    if (idleTimeoutMs > 0 && Date.now() - lastClickTime > idleTimeoutMs) {
      const dakika = Math.round((Date.now() - lastClickTime) / 60000);
      stats.stopReason = `${config.behavior.idle_timeout_minutes}dk boyunca tıklama yok (${dakika}dk geçti)`;
      return true;
    }
    if (!unlimited && stats.completed >= maxRun) return true;
    return false;
  }

  function launchSession() {
    if (active.size >= concurrency) return false;
    if (parsedQueries.length === 0) return false;
    if (Date.now() < concurrencyBackoffUntil) return false;

    const queryDef = parsedQueries[Math.floor(Math.random() * parsedQueries.length)];
    sessionCounter++;
    const sessionLabel = `#${sessionCounter}`;
    console.log(`▶ Session ${sessionLabel} "${queryDef.search}" | aktif: ${active.size + 1}/${concurrency}`);

    const promise = runOneSession(provider, queryDef, sessionLabel).catch((e) => {
      console.error(`Session hatası ${sessionLabel}: ${e.message.split("\n")[0]}`);
      return { clicked: 0, hits: 0, adsFound: 0 };
    });
    active.set(promise, sessionLabel);
    promise.then((r) => {
      if (r && (r.clicked > 0 || (r.hits || 0) > 0)) lastClickTime = Date.now();
      if (r && r.error === "concurrency_limit") {
        concurrencyBackoffUntil = Date.now() + 15000; // 15s sessiz bekle, sonra tekrar
        console.log(`⚠ Hyperbrowser concurrency limit — 15s yeni session açma`);
      }
      active.delete(promise);
      console.log(`◀ Session ${sessionLabel} | aktif: ${active.size}`);
    });
    return true;
  }

  // Cluster pattern önlemek için session açılışları arasında uzun stagger.
  // Google 5 concurrent session'ı 10 saniyede burst görürse hepsine captcha.
  const staggerSec = config.behavior.session_stagger_seconds || 20;
  const staggerJitter = staggerSec * 0.5; // ±%50 jitter

  // İlk batch — yavaş yavaş aç
  for (let i = 0; i < concurrency; i++) {
    if (shouldStop()) break;
    if (i > 0) {
      const wait = (staggerSec + (Math.random() - 0.5) * 2 * staggerJitter) * 1000;
      await sleep(wait);
    }
    if (!launchSession()) break;
  }

  // Continuous queue — yine stagger ile
  while (!shouldStop()) {
    while (active.size < concurrency && !shouldStop()) {
      const wait = (staggerSec + (Math.random() - 0.5) * 2 * staggerJitter) * 1000;
      await sleep(wait);
      if (!launchSession()) break;
    }
    if (active.size === 0) {
      await sleep(3000);
      continue;
    }
    await Promise.race([
      Promise.race([...active.keys()]),
      sleep(30000),
    ]);
  }

  console.log(`\nDurma sinyali, kalan ${active.size} session bekleniyor...`);
  await Promise.allSettled([...active.keys()]);
}

module.exports = { runModel2 };
