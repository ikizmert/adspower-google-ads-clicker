const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const { config, queries, parseQuery } = require("./config");
const provider = config.provider === "hyperbrowser" ? require("./hyperbrowser") : require("./adspower");
const { checkStatus, openBrowser, closeBrowser, listProfiles, clearCache, applyStickyProxy } = provider;
const { searchAndClick, closeExtraTabs, enableImageBlocking, clearGoogleCookies, sessionWarmup } = require("./searcher");
const tracker = require("./profile-tracker");
const clickCounter = require("./click-counter");
const { state: stats } = require("./stats");

function printSummary() {
  console.log(`\n=== Kampanya tamamlandı ===`);
  if (stats.stopReason) console.log(`  Durma sebebi: ${stats.stopReason}`);
  console.log(`  Tamamlanan session: ${stats.completed}${stats.maxRun === Infinity ? "" : "/" + stats.maxRun}`);
  console.log(`  Toplam reklam tıklaması: ${stats.totalClicked}`);
  const adDomains = Object.entries(stats.adsByDomain).sort((a, b) => b[1] - a[1]);
  for (const [d, n] of adDomains) {
    console.log(`    ${d}: ${n}`);
  }
  console.log(`  Toplam organik tıklama: ${stats.totalHits}`);
  const hitDomains = Object.entries(stats.hitsByDomain).sort((a, b) => b[1] - a[1]);
  for (const [d, n] of hitDomains) {
    console.log(`    ${d}: ${n}`);
  }
  console.log(`  Toplam başarısız session: ${stats.totalFailed}`);
}

let summaryPrinted = false;
process.on("SIGINT", () => {
  if (!summaryPrinted) {
    summaryPrinted = true;
    stats.stopReason = "Kullanıcı durdurdu (Ctrl+C)";
    printSummary();
  }
  process.exit(0);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getUsableProfiles(allProfiles) {
  const mobileKeywords = ["mobile", "android", "iphone", "ipad", "ios"];
  const excludeKeywords = ["pilot", "test", "template"];
  return allProfiles.filter((p) => {
    const group = (p.groupName || "").toLowerCase();
    const name = (p.name || "").toLowerCase();
    if (mobileKeywords.some((k) => group.includes(k) || name.includes(k))) return false;
    if (excludeKeywords.some((k) => name.includes(k))) return false;
    return true;
  });
}

async function resetIfNeeded(profiles) {
  for (const p of profiles) {
    const reason = tracker.shouldReset(p.id, config.behavior.max_sessions_per_profile || 5);
    if (reason) {
      console.log(`Profil "${p.name || p.id}" sıfırlanıyor (sebep: ${reason})...`);
      await clearCache(p.id);
      tracker.removeProfile(p.id);
    }
  }
}

function pickProfiles(profiles, count, excludeIds = new Set()) {
  const available = profiles.filter((p) => !excludeIds.has(p.id));
  const shuffled = [...available];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

async function runSession(profile, parsedQueries) {
  const profileId = profile.id;
  const sessionLabel = `#${profile.serial || "?"}`;
  const profileName = profile.name || profileId;
  const profileStats = tracker.getProfile(profileId);

  console.log(`[${sessionLabel}] ${profileName} (oturum: ${profileStats.sessions + 1}/5) başlıyor...`);

  // Browser açılmadan önce sticky proxy uygula (session boyunca sabit IP)
  await applyStickyProxy(profileId).catch(() => {});

  let browser;
  try {
    const { wsEndpoint } = await openBrowser(profileId);
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  } catch (e) {
    console.error(`[${sessionLabel}] Browser açılamadı: ${e.message}`);
    return { clicked: 0, hits: 0, adsFound: 0 };
  }

  if (config.behavior.block_images) {
    await enableImageBlocking(browser);
  }

  await closeExtraTabs(browser);

  if (config.behavior.new_session_clear_google_cookies) {
    await clearGoogleCookies(browser);
  }

  // Passive mod
  if (process.argv.includes("--passive")) {
    console.log(`[${sessionLabel}] PASSIVE MODE — manuel arama yap, Ctrl+C ile çık`);
    await new Promise(() => {});
  }

  const sessionQueries = shuffle([...parsedQueries]);
  let sessionAdsFound = 0;
  let sessionClicked = 0;
  let sessionHits = 0;
  const sessionRankings = [];
  const sessionAdClicks = {}; // domain bazlı session tıklama sayacı

  for (let qi = 0; qi < sessionQueries.length; qi++) {
    const q = sessionQueries[qi];
    let result;
    try {
      result = await searchAndClick(browser, q.search, q.adDomains, q.hitDomains, sessionLabel, sessionAdClicks);
    } catch (e) {
      console.error(`[${sessionLabel}] Query hatası ("${q.search}"): ${e.message.split("\n")[0]} — atlanıyor`);
      continue;
    }

    // Captcha veya connection error → browser kapat, yeni IP ile tekrar dene (max 3 retry)
    const needsRetry = (r) => r && (r.error === "bot_detected" || r.error === "search_failed");
    if (needsRetry(result) && qi === 0) {
      for (let retry = 1; retry <= 3; retry++) {
        const reason = result.error === "bot_detected" ? "Captcha" : "Bağlantı hatası";
        console.log(`[${sessionLabel}] ⚠ ${reason} — yeni IP deneniyor (${retry}/3)...`);
        try { browser.disconnect(); await closeBrowser(profileId); } catch {}
        await sleep(2000);
        await applyStickyProxy(profileId).catch(() => {});
        try {
          const { wsEndpoint } = await openBrowser(profileId);
          browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
          await closeExtraTabs(browser);
          result = await searchAndClick(browser, q.search, q.adDomains, q.hitDomains, sessionLabel, sessionAdClicks);
          if (!needsRetry(result)) break;
        } catch (e) {
          console.log(`[${sessionLabel}] Retry ${retry} başarısız: ${e.message.split("\n")[0]}`);
        }
      }
    }

    if (result && result.totalAdsOnPage > 0) sessionAdsFound += result.totalAdsOnPage;
    if (result && result.hits > 0) sessionHits += result.hits;
    if (result && result.ads > 0) sessionClicked += result.ads;
    if (result && result.rankings) sessionRankings.push({ query: q.search, rankings: result.rankings, notFound: result.notFound || [] });

    if (needsRetry(result)) {
      const reason = result.error === "bot_detected" ? "captcha" : "bağlantı hatası";
      console.log(`[${sessionLabel}] ⚠ 3 retry sonrası hala ${reason} — session atlanıyor`);
      break;
    }

    const wait = (5 + Math.random() * 10) * config.behavior.wait_factor;
    console.log(`[${sessionLabel}] ${wait.toFixed(1)}s bekleniyor...\n`);
    await sleep(wait * 1000);
  }

  try {
    browser.disconnect();
    await closeBrowser(profileId);
  } catch {}

  // Session anında stats'a kaydet (Ctrl+C anında doğru sayım için)
  stats.completed++;
  if (sessionClicked === 0) stats.totalFailed++;

  const updated = tracker.recordSession(profileId, sessionAdsFound);
  console.log(`[${sessionLabel}] Bitti | tıklanan: ${sessionClicked} | reklam: ${sessionAdsFound} | no_ads_streak: ${updated.no_ads_streak}`);

  // Hit domain sıralama özeti
  if (sessionRankings.length > 0) {
    console.log(`[${sessionLabel}] === Hit domain sıralamaları ===`);
    for (const sr of sessionRankings) {
      if (sr.rankings.length > 0) {
        for (const r of sr.rankings) {
          console.log(`[${sessionLabel}]   "${sr.query}" → ${r.domain}: Sayfa ${r.page}, Sıra ${r.position} (genel: ${r.globalPosition})`);
        }
      }
      for (const nf of sr.notFound) {
        console.log(`[${sessionLabel}]   "${sr.query}" → ${nf}: bulunamadı`);
      }
    }
  }

  // Domain başına kümülatif tıklama (tüm runlar boyunca)
  const totals = clickCounter.getAll();
  const domains = Object.keys(totals);
  if (domains.length > 0) {
    console.log(`[${sessionLabel}] === Toplam tıklama (kümülatif) ===`);
    for (const domain of domains) {
      const t = totals[domain];
      console.log(`[${sessionLabel}]   ${domain}: ${t.ads || 0} reklam, ${t.hits || 0} organik`);
    }
  }

  return { clicked: sessionClicked, hits: sessionHits, adsFound: sessionAdsFound };
}

async function run() {
  const alive = await checkStatus().catch(() => false);
  if (!alive) {
    console.error("AdsPower çalışmıyor! Önce AdsPower'ı başlatın.");
    process.exit(1);
  }

  const allProfiles = await listProfiles();
  let profiles = getUsableProfiles(allProfiles);
  if (profiles.length === 0) {
    console.error("Kullanılabilir desktop profil yok!");
    process.exit(1);
  }

  // CLI: node src/index.js 41 → sadece serial 41 olan profili çalıştır
  const cliSerial = process.argv[2];
  if (cliSerial) {
    profiles = profiles.filter((p) => String(p.serial) === String(cliSerial));
    if (profiles.length === 0) {
      console.error(`Serial ${cliSerial} olan profil bulunamadı!`);
      process.exit(1);
    }
    console.log(`Tek profil modu: #${cliSerial}`);
  }

  const browserCount = cliSerial ? 1 : (config.behavior.browser_count || 1);
  const maxRun = cliSerial ? 1 : config.behavior.max_run;
  const maxTotalClicks = config.behavior.max_total_clicks || 0;
  const idleTimeoutMs = (config.behavior.idle_timeout_minutes || 0) * 60 * 1000;
  const parsedQueries = queries.map(parseQuery);

  const unlimited = !maxRun || maxRun <= 0;
  console.log(`Profil: ${profiles.length} | Paralel: ${browserCount} | Session: ${unlimited ? "sınırsız" : maxRun}` +
    (maxTotalClicks ? ` | Max tıklama: ${maxTotalClicks}` : "") +
    (idleTimeoutMs ? ` | Idle timeout: ${config.behavior.idle_timeout_minutes}dk` : ""));
  console.log(`Query: ${parsedQueries.length} | Bekleme: ${config.behavior.ad_page_min_wait}-${config.behavior.ad_page_max_wait}s\n`);

  stats.maxRun = unlimited ? Infinity : maxRun;
  let lastClickTime = Date.now();
  let lastClickedSnapshot = stats.totalClicked;
  const SESSION_TIMEOUT = 8 * 60 * 1000;

  // Continuous queue: ana loop sequential, sessionlar paralel
  const active = new Map(); // promise -> profileId

  function shouldStop() {
    // stats.totalClicked anlık güncelleniyor (searcher.js recordAd) — değişimi izle
    if (stats.totalClicked > lastClickedSnapshot) {
      lastClickedSnapshot = stats.totalClicked;
      lastClickTime = Date.now();
    }
    if (maxTotalClicks > 0 && stats.totalClicked >= maxTotalClicks) {
      stats.stopReason = `Max tıklama (${maxTotalClicks}) ulaşıldı`;
      return true;
    }
    if (idleTimeoutMs > 0 && Date.now() - lastClickTime > idleTimeoutMs) {
      const dakika = Math.round((Date.now() - lastClickTime) / 60000);
      stats.stopReason = `${config.behavior.idle_timeout_minutes}dk boyunca reklam tıklama yok (${dakika}dk geçti)`;
      return true;
    }
    if (!unlimited && stats.completed >= maxRun) return true;
    return false;
  }

  function launchSession(profile) {
    console.log(`▶ Session başlıyor: #${profile.serial || profile.id} | aktif: ${active.size + 1}`);
    let cleaned = false;
    const sessionPromise = (async () => {
      try {
        return await Promise.race([
          runSession(profile, parsedQueries),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Session timeout (8dk)")), SESSION_TIMEOUT)),
        ]);
      } catch (e) {
        console.error(`Session hatası (#${profile.serial || profile.id}): ${e.message.split("\n")[0]} — atlanıyor`);
        try { await closeBrowser(profile.id); } catch {}
        return { clicked: 0, hits: 0, adsFound: 0 };
      }
    })();
    active.set(sessionPromise, profile.id);
    sessionPromise.then((r) => {
      if (cleaned) return;
      cleaned = true;
      if (r && (r.clicked > 0 || (r.hits || 0) > 0)) lastClickTime = Date.now();
      active.delete(sessionPromise);
      console.log(`◀ Session bitti: #${profile.serial || profile.id} | aktif: ${active.size}`);
    });
  }

  // İlk batch: browser_count kadar session başlat (stagger ile)
  for (let i = 0; i < browserCount; i++) {
    if (shouldStop()) break;
    if (i > 0) await sleep(3000 + Math.random() * 3000); // 3-6s stagger
    await resetIfNeeded(profiles);
    const activeIds = new Set(active.values());
    const [profile] = pickProfiles(profiles, 1, activeIds);
    if (!profile) break;
    launchSession(profile);
  }

  // Continuous queue: periyodik slot kontrolü (her 30s veya bir session bittiğinde)
  while (!shouldStop()) {
    // Boş slot varsa doldur
    while (active.size < browserCount && !shouldStop()) {
      await sleep(2000 + Math.random() * 2000); // 2-4s aralık
      await resetIfNeeded(profiles);
      const activeIds = new Set(active.values());
    const [profile] = pickProfiles(profiles, 1, activeIds);
      if (!profile) break;
      launchSession(profile);
    }

    if (active.size === 0) {
      await sleep(5000);
      continue;
    }

    // Bir session bitene kadar bekle (max 30s — asılı kalanlar için periyodik kontrol)
    await Promise.race([
      Promise.race([...active.keys()]),
      sleep(30000),
    ]);
  }

  // Kalan session'ları bekle
  console.log(`\nDurma sinyali, kalan ${active.size} session bekleniyor...`);
  await Promise.allSettled([...active.keys()]);

  if (!summaryPrinted) {
    summaryPrinted = true;
    printSummary();
  }
}

run().catch((e) => {
  console.error("Kritik hata:", e.message);
  process.exit(1);
});
