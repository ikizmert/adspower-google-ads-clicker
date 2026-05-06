const puppeteer = require("puppeteer-core");
const { config, queries, parseQuery } = require("./config");
const { checkStatus, openBrowser, closeBrowser, listProfiles, getProfileInfo, clearCache } = require("./adspower");
const { searchAndClick, closeExtraTabs } = require("./searcher");
const tracker = require("./profile-tracker");


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
  return allProfiles.filter((p) => {
    const group = (p.groupName || "").toLowerCase();
    const name = (p.name || "").toLowerCase();
    return !mobileKeywords.some((k) => group.includes(k) || name.includes(k));
  });
}

async function resetIfNeeded(profiles) {
  for (const p of profiles) {
    const reason = tracker.shouldReset(p.id);
    if (reason) {
      console.log(`Profil "${p.name || p.id}" sıfırlanıyor (sebep: ${reason})...`);
      await clearCache(p.id);
      tracker.removeProfile(p.id);
    }
  }
}

function pickProfiles(profiles, count) {
  const ids = profiles.map((p) => p.id);
  const picked = [];
  const sorted = [...ids].sort((a, b) => {
    const sa = (tracker.getProfile(a)).sessions;
    const sb = (tracker.getProfile(b)).sessions;
    return sa - sb;
  });
  for (let i = 0; i < Math.min(count, sorted.length); i++) {
    picked.push(sorted[i]);
  }
  return picked;
}

async function runSession(profileId, parsedQueries, sessionLabel) {
  const info = await getProfileInfo(profileId);
  const profileName = info ? info.name || profileId : profileId;
  const stats = tracker.getProfile(profileId);

  console.log(`[${sessionLabel}] ${profileName} (oturum: ${stats.sessions + 1}/5) başlıyor...`);

  let browser;
  try {
    const { wsEndpoint } = await openBrowser(profileId);
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  } catch (e) {
    console.error(`[${sessionLabel}] Browser açılamadı: ${e.message}`);
    return { clicked: 0, adsFound: 0 };
  }

  await closeExtraTabs(browser);

  const sessionQueries = shuffle([...parsedQueries]);
  let sessionAdsFound = 0;
  let sessionClicked = 0;

  for (const q of sessionQueries) {
    const result = await searchAndClick(browser, q.search, q.domains);

    if (result.totalAdsOnPage > 0) sessionAdsFound += result.totalAdsOnPage;
    if (result.ads > 0) sessionClicked += result.ads;

    const wait = (5 + Math.random() * 10) * config.behavior.wait_factor;
    console.log(`[${sessionLabel}] ${wait.toFixed(1)}s bekleniyor...\n`);
    await sleep(wait * 1000);
  }

  try {
    browser.disconnect();
    await closeBrowser(profileId);
  } catch {}

  const updated = tracker.recordSession(profileId, sessionAdsFound);
  console.log(`[${sessionLabel}] Bitti | tıklanan: ${sessionClicked} | reklam: ${sessionAdsFound} | no_ads_streak: ${updated.no_ads_streak}`);

  return { clicked: sessionClicked, adsFound: sessionAdsFound };
}

async function run() {
  const alive = await checkStatus().catch(() => false);
  if (!alive) {
    console.error("AdsPower çalışmıyor! Önce AdsPower'ı başlatın.");
    process.exit(1);
  }

  const allProfiles = await listProfiles();
  const profiles = getUsableProfiles(allProfiles);
  if (profiles.length === 0) {
    console.error("Kullanılabilir desktop profil yok!");
    process.exit(1);
  }

  const browserCount = config.behavior.browser_count || 1;
  const maxRun = config.behavior.max_run;
  const parsedQueries = queries.map(parseQuery);

  console.log(`Profil: ${profiles.length} | Paralel: ${browserCount} | Session: ${maxRun}`);
  console.log(`Query: ${parsedQueries.length} | Bekleme: ${config.behavior.ad_page_min_wait}-${config.behavior.ad_page_max_wait}s\n`);

  let totalClicked = 0;
  let totalFailed = 0;
  let completed = 0;

  while (completed < maxRun) {
    await resetIfNeeded(profiles);

    const batchSize = Math.min(browserCount, maxRun - completed, profiles.length);
    const selectedIds = pickProfiles(profiles, batchSize);

    console.log(`\n=== Batch ${Math.floor(completed / batchSize) + 1} (${selectedIds.length} paralel) ===`);

    const promises = selectedIds.map((id, i) =>
      runSession(id, parsedQueries, `B${completed + i + 1}`)
    );
    const results = await Promise.all(promises);

    for (const r of results) {
      totalClicked += r.clicked;
      if (r.clicked === 0) totalFailed++;
      completed++;
    }

    console.log(`Batch bitti | toplam: ${completed}/${maxRun} | tıklanan: ${totalClicked} | başarısız: ${totalFailed}`);

    if (completed < maxRun) {
      const wait = (3 + Math.random() * 5) * config.behavior.wait_factor;
      console.log(`Sonraki batch için ${wait.toFixed(1)}s bekleniyor...`);
      await sleep(wait * 1000);
    }
  }

  console.log(`\n=== Kampanya tamamlandı ===`);
  console.log(`  Toplam tıklanan: ${totalClicked}`);
  console.log(`  Toplam başarısız: ${totalFailed}`);
}

run().catch((e) => {
  console.error("Kritik hata:", e.message);
  process.exit(1);
});
