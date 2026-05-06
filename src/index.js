const puppeteer = require("puppeteer-core");
const { config, queries, parseQuery } = require("./config");
const { checkStatus, openBrowser, closeBrowser, listProfiles, clearCache } = require("./adspower");
const { searchAndClick, closeExtraTabs, enableImageBlocking } = require("./searcher");
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
    const reason = tracker.shouldReset(p.id);
    if (reason) {
      console.log(`Profil "${p.name || p.id}" sıfırlanıyor (sebep: ${reason})...`);
      await clearCache(p.id);
      tracker.removeProfile(p.id);
    }
  }
}

function pickProfiles(profiles, count) {
  // Hiç kullanılmamış profiller (sessions=0)
  const unused = profiles.filter((p) => !tracker.getProfile(p.id).sessions);
  // Kullanılmışlar - en uzun süre önce kullanılan başta
  const used = profiles
    .filter((p) => tracker.getProfile(p.id).sessions)
    .sort((a, b) => {
      const la = tracker.getProfile(a.id).last_used || 0;
      const lb = tracker.getProfile(b.id).last_used || 0;
      return la - lb;
    });

  // Hiç kullanılmamışları rastgele karıştır
  for (let i = unused.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unused[i], unused[j]] = [unused[j], unused[i]];
  }

  // Önce unused, sonra used
  const all = [...unused, ...used];
  return all.slice(0, Math.min(count, all.length));
}

async function runSession(profile, parsedQueries) {
  const profileId = profile.id;
  const sessionLabel = `#${profile.serial || "?"}`;
  const profileName = profile.name || profileId;
  const profileStats = tracker.getProfile(profileId);

  console.log(`[${sessionLabel}] ${profileName} (oturum: ${profileStats.sessions + 1}/5) başlıyor...`);

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

  // Profili pilot klonu state'inde bırak — temizleme yapma
  // (cache/cookie temizleme Google'a "fresh user" sinyali veriyor → captcha)

  await closeExtraTabs(browser);

  const sessionQueries = shuffle([...parsedQueries]);
  let sessionAdsFound = 0;
  let sessionClicked = 0;
  let sessionHits = 0;
  const sessionRankings = [];

  for (const q of sessionQueries) {
    try {
      const result = await searchAndClick(browser, q.search, q.adDomains, q.hitDomains, sessionLabel);

      if (result.totalAdsOnPage > 0) sessionAdsFound += result.totalAdsOnPage;
      // stats.totalClicked / stats.totalHits searcher.js'de tıklama anında artırılıyor
      if (result.hits > 0) sessionHits += result.hits;
      if (result.ads > 0) sessionClicked += result.ads;
      if (result.rankings) sessionRankings.push({ query: q.search, rankings: result.rankings, notFound: result.notFound || [] });
    } catch (e) {
      console.error(`[${sessionLabel}] Query hatası ("${q.search}"): ${e.message.split("\n")[0]} — atlanıyor`);
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

  while (unlimited || stats.completed < maxRun) {
    if (maxTotalClicks > 0 && stats.totalClicked >= maxTotalClicks) {
      stats.stopReason = `Max tıklama (${maxTotalClicks}) ulaşıldı`;
      break;
    }
    if (idleTimeoutMs > 0 && Date.now() - lastClickTime > idleTimeoutMs) {
      stats.stopReason = `${config.behavior.idle_timeout_minutes}dk boyunca tıklama yok`;
      break;
    }

    await resetIfNeeded(profiles);

    const remaining = unlimited ? Infinity : (maxRun - stats.completed);
    const batchSize = Math.min(browserCount, remaining, profiles.length);
    const selectedProfiles = pickProfiles(profiles, batchSize);

    const profileLabels = selectedProfiles.map((p) => `#${p.serial || p.id}`).join(", ");
    console.log(`\n=== Batch (${selectedProfiles.length} paralel: ${profileLabels}) ===`);

    const promises = selectedProfiles.map(async (profile, i) => {
      await sleep(i * 3000);
      try {
        return await runSession(profile, parsedQueries);
      } catch (e) {
        console.error(`Session hatası (#${profile.serial || profile.id}): ${e.message.split("\n")[0]} — atlanıyor`);
        return { clicked: 0, hits: 0, adsFound: 0 };
      }
    });
    const results = await Promise.allSettled(promises);

    // stats.completed/totalClicked/totalHits/totalFailed runSession içinde güncellenmiş durumda
    for (const settled of results) {
      const r = settled.status === "fulfilled" ? settled.value : { clicked: 0, hits: 0 };
      if (r.clicked > 0 || (r.hits || 0) > 0) lastClickTime = Date.now();
    }

    console.log(`Batch bitti | toplam: ${stats.completed}/${maxRun} | reklam tıklama: ${stats.totalClicked} | organik tıklama: ${stats.totalHits} | başarısız: ${stats.totalFailed}`);

    if (stats.completed < maxRun) {
      const wait = (3 + Math.random() * 5) * config.behavior.wait_factor;
      console.log(`Sonraki batch için ${wait.toFixed(1)}s bekleniyor...`);
      await sleep(wait * 1000);
    }
  }

  if (!summaryPrinted) {
    summaryPrinted = true;
    printSummary();
  }
}

run().catch((e) => {
  console.error("Kritik hata:", e.message);
  process.exit(1);
});
