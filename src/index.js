const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const { config, queries, parseQuery } = require("./config");
const provider = config.provider === "hyperbrowser" ? require("./hyperbrowser") : require("./adspower");
const { checkStatus, openBrowser, closeBrowser, listProfiles, applyStickyProxy } = provider;
const { searchAndClick, closeExtraTabs, enableImageBlocking, clearAllGoogleCookies, sessionWarmup, doFillerSearches } = require("./searcher");
const { createProfileStateManager } = require("./profile-state");
const tracker = require("./profile-tracker");
const clickCounter = require("./click-counter");
const { state: stats } = require("./stats");
const path = require("path");
const { createTracker } = require("./budget-tracker");

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
      // clearCache (AdsPower delete-cache) KALDIRILDI — extension storage'ı da siliyordu
      // Sadece tracker sıfırlanır, cookie temizleme click session sonunda clearAllGoogleCookies ile yapılıyor
      tracker.removeProfile(p.id);
    }
  }
}

async function runWarmupSession(profile, profileState) {
  const profileId = profile.id;
  const sessionLabel = `#${profile.serial || "?"}`;
  const profileName = profile.name || profileId;
  console.log(`[${sessionLabel}] ${profileName} WARMUP başlıyor...`);

  profileState.transition(profileId, "warming");

  const proxyApplied = await applyStickyProxy(profileId).catch(() => null);
  if (proxyApplied && proxyApplied.sid) {
    profileState.setSid(profileId, proxyApplied.sid);
  }

  let browser;
  try {
    const { wsEndpoint } = await openBrowser(profileId);
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  } catch (e) {
    console.error(`[${sessionLabel}] Warmup browser açılamadı (transient): ${e.message.split("\n")[0]}`);
    // ECONNREFUSED gibi transient hatalar — profili hemen tekrar denenebilir yap
    profileState.transition(profileId, "cold", { failure: false });
    return { success: false };
  }

  if (config.behavior.block_images) {
    await enableImageBlocking(browser);
  }
  await closeExtraTabs(browser);

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  let result;
  try {
    result = await sessionWarmup(page, `[${sessionLabel}] `);
  } catch (e) {
    console.error(`[${sessionLabel}] Warmup hatası: ${e.message.split("\n")[0]}`);
    result = { success: false, hadCaptcha: false };
  }

  try { browser.disconnect(); await closeBrowser(profileId); } catch {}

  if (result.success) {
    profileState.transition(profileId, "warm");
    console.log(`[${sessionLabel}] ✓ Warmup OK → warm`);
  } else if (result.hadCaptcha) {
    profileState.transition(profileId, "cold", { failure: true });
    console.log(`[${sessionLabel}] ✗ Warmup captcha → cold + 15dk cooldown`);
  } else {
    profileState.transition(profileId, "cold", { failure: false });
    console.log(`[${sessionLabel}] ✗ Warmup hata → cold (hemen tekrar denenebilir)`);
  }
  return result;
}

async function runClickSession(profile, profileState, parsedQueries, budgetTracker) {
  let captchaHit = false;
  const profileId = profile.id;
  const sessionLabel = `#${profile.serial || "?"}`;
  const profileName = profile.name || profileId;
  console.log(`[${sessionLabel}] ${profileName} CLICK başlıyor (warm profil)...`);

  profileState.transition(profileId, "clicking");

  // Warmup'ta üretilen aynı sid'i kullan — IP cookie ile eşleşsin (captcha önle)
  const storedSid = profileState.getSid(profileId);
  let proxyApplied = await applyStickyProxy(profileId, storedSid).catch(() => null);

  let browser;
  try {
    const { wsEndpoint } = await openBrowser(profileId);
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  } catch (e) {
    console.error(`[${sessionLabel}] Click browser açılamadı (transient): ${e.message.split("\n")[0]}`);
    // ECONNREFUSED gibi transient hatalar — profil warm kalsın, sonraki click attempt'te tekrar denesin
    profileState.transition(profileId, "warm");
    return { clicked: 0, hits: 0, adsFound: 0 };
  }

  if (config.behavior.block_images) {
    await enableImageBlocking(browser);
  }
  await closeExtraTabs(browser);
  // NOT: Click session'da cookie temizleme YOK — warmup'tan kalan cookies kullanılır.

  // Filler aramalar — target query'lerden önce 1-2 alakasız Google araması + organik tıklama
  // (Google session'da "doğal kullanıcı davranışı" sinyali)
  const fillerCount = config.behavior.filler_queries_per_session || 0;
  if (fillerCount > 0) {
    const fillerResult = await doFillerSearches(browser, fillerCount, proxyApplied, `[${sessionLabel}] `).catch(() => ({ hadCaptcha: false }));
    if (fillerResult.hadCaptcha && !fillerResult.solved) {
      console.log(`[${sessionLabel}] ⚠ Filler captcha (captcha_action=abort) — session terk`);
      try { await clearAllGoogleCookies(browser); } catch {}
      try { browser.disconnect(); await closeBrowser(profileId); } catch {}
      profileState.transition(profileId, "cooling", { failure: true });
      stats.completed++;
      stats.totalFailed++;
      return { clicked: 0, hits: 0, adsFound: 0 };
    }
  }

  // Passive mod — manuel debug için browser açık tut
  if (process.argv.includes("--passive")) {
    console.log(`[${sessionLabel}] PASSIVE MODE — manuel arama yap, Ctrl+C ile çık`);
    await new Promise(() => {});
  }

  const sessionQueries = shuffle([...parsedQueries]);
  let sessionAdsFound = 0;
  let sessionClicked = 0;
  let sessionHits = 0;
  const sessionRankings = [];
  const sessionAdClicks = {};

  for (let qi = 0; qi < sessionQueries.length; qi++) {
    const q = sessionQueries[qi];
    let result;
    try {
      result = await searchAndClick(browser, q.search, q.adDomains, q.hitDomains, sessionLabel, sessionAdClicks, budgetTracker, proxyApplied);
    } catch (e) {
      console.error(`[${sessionLabel}] Query hatası ("${q.search}"): ${e.message.split("\n")[0]} — atlanıyor`);
      continue;
    }

    if (result && result.totalAdsOnPage > 0) sessionAdsFound += result.totalAdsOnPage;
    if (result && result.hits > 0) sessionHits += result.hits;
    if (result && result.ads > 0) sessionClicked += result.ads;
    if (result && result.rankings) sessionRankings.push({ query: q.search, rankings: result.rankings, notFound: result.notFound || [] });

    if (result && result.error === "bot_detected") {
      console.log(`[${sessionLabel}] ⚠ Captcha (captcha_action=abort) — session terk`);
      captchaHit = true;
      break;
    }
    if (result && result.error === "search_failed") {
      console.log(`[${sessionLabel}] ⚠ Bağlantı hatası — session terk`);
      break;
    }

    const wait = (5 + Math.random() * 10) * config.behavior.wait_factor;
    console.log(`[${sessionLabel}] ${wait.toFixed(1)}s bekleniyor...\n`);
    await sleep(wait * 1000);
  }

  // KESINLIKLE çalışmalı — full cookie wipe
  try {
    await clearAllGoogleCookies(browser);
  } catch (e) {
    console.error(`[${sessionLabel}] ✗ Cookie wipe hatası: ${e.message.split("\n")[0]}`);
  }

  try { browser.disconnect(); await closeBrowser(profileId); } catch {}

  profileState.transition(profileId, "cooling", { failure: captchaHit });

  stats.completed++;
  if (sessionClicked === 0) stats.totalFailed++;

  tracker.recordSession(profileId, sessionAdsFound);
  console.log(`[${sessionLabel}] CLICK bitti | tıklanan: ${sessionClicked} | reklam: ${sessionAdsFound}${captchaHit ? " | captcha" : ""}`);

  if (sessionRankings.length > 0) {
    console.log(`[${sessionLabel}] === Hit domain sıralamaları ===`);
    for (const sr of sessionRankings) {
      for (const r of sr.rankings) {
        console.log(`[${sessionLabel}]   "${sr.query}" → ${r.domain}: Sayfa ${r.page}, Sıra ${r.position} (genel: ${r.globalPosition})`);
      }
      for (const nf of sr.notFound) {
        console.log(`[${sessionLabel}]   "${sr.query}" → ${nf}: bulunamadı`);
      }
    }
  }

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

  const clickBrowserCount = cliSerial ? 1 : (config.behavior.click_browser_count || 5);
  const warmupBrowserCount = cliSerial ? 0 : (config.behavior.warmup_browser_count || 5);
  const totalSlots = clickBrowserCount + warmupBrowserCount;
  const maxRun = cliSerial ? 1 : config.behavior.max_run;
  const maxTotalClicks = config.behavior.max_total_clicks || 0;
  const idleTimeoutMs = (config.behavior.idle_timeout_minutes || 0) * 60 * 1000;
  const parsedQueries = queries.map(parseQuery);

  // Budget tracker (adaptive targeting)
  const adaptive = config.behavior.adaptive_targeting || {};
  const budgetTracker = adaptive.enabled ? createTracker({
    stateFile: path.join(__dirname, "..", "budget-state.json"),
    threshold: adaptive.missed_threshold || 3,
  }) : null;

  const unlimited = !maxRun || maxRun <= 0;
  console.log(`Profil: ${profiles.length} | Click: ${clickBrowserCount} | Warmup: ${warmupBrowserCount} | Session: ${unlimited ? "sınırsız" : maxRun}` +
    (maxTotalClicks ? ` | Max tıklama: ${maxTotalClicks}` : "") +
    (idleTimeoutMs ? ` | Idle timeout: ${config.behavior.idle_timeout_minutes}dk` : ""));
  console.log(`Query: ${parsedQueries.length} | Bekleme: ${config.behavior.ad_page_min_wait}-${config.behavior.ad_page_max_wait}s\n`);

  stats.maxRun = unlimited ? Infinity : maxRun;
  let lastClickTime = Date.now();
  let lastActivitySnapshot = stats.totalClicked + stats.totalHits;
  const SESSION_TIMEOUT = (config.behavior.session_timeout_minutes || 15) * 60 * 1000;

  function shouldStop() {
    // Reklam + organik tıklamalar anlık güncelleniyor — değişimi izle
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

    // Adaptive: tüm target domainler exhausted ise dur
    if (budgetTracker) {
      const allTargets = [...new Set(parsedQueries.flatMap((q) => q.adDomains))];
      if (allTargets.length > 0 && budgetTracker.allTargetsExhausted(allTargets)) {
        stats.stopReason = "Tüm rakipler bütçelerini bitirdi (adaptive)";
        return true;
      }
    }

    if (!unlimited && stats.completed >= maxRun) return true;
    return false;
  }

  const profileState = createProfileStateManager({
    stateFile: path.join(__dirname, "..", "profile-state.json"),
    successCooldownMs: (config.behavior.post_click_cooldown_minutes || 5) * 60 * 1000,
    failureCooldownMs: (config.behavior.captcha_failure_cooldown_minutes || 15) * 60 * 1000,
  });

  const resetCount = profileState.resetStaleBusyStates();
  if (resetCount > 0) {
    console.log(`⚙ ${resetCount} profil önceki run'dan warming/clicking state'inde takılıydı → cold reset`);
  }

  const active = new Map(); // promise -> { profileId, type }

  function activeCounts() {
    let click = 0, warmup = 0;
    for (const { type } of active.values()) {
      if (type === "click") click++;
      else if (type === "warmup") warmup++;
    }
    return { click, warmup };
  }

  function hasPendingTargets() {
    if (!budgetTracker) return true;
    const allTargets = [...new Set(parsedQueries.flatMap((q) => q.adDomains))];
    return !budgetTracker.allTargetsExhausted(allTargets);
  }

  function launchTask() {
    if (active.size >= totalSlots) return false;

    const counts = activeCounts();
    const allowedTypes = [];
    if (counts.click < clickBrowserCount) allowedTypes.push("click");
    if (counts.warmup < warmupBrowserCount) allowedTypes.push("warmup");
    if (allowedTypes.length === 0) return false;

    const activeIds = new Set([...active.values()].map(v => v.profileId));
    const candidateProfiles = profiles.filter((p) => !activeIds.has(p.id)).map((p) => p.id);
    const decision = profileState.selectNextTask(candidateProfiles, hasPendingTargets(), allowedTypes);
    if (!decision) return false;

    // warmup_enabled flag — devre dışı bırakmak için
    if (decision.type === "warmup" && config.behavior.warmup_enabled === false) {
      return false;
    }

    const profile = profiles.find((p) => p.id === decision.profileId);
    if (!profile) return false;

    console.log(`▶ ${decision.type.toUpperCase()} başlıyor: #${profile.serial || profile.id} | click: ${counts.click + (decision.type === "click" ? 1 : 0)}/${clickBrowserCount} warmup: ${counts.warmup + (decision.type === "warmup" ? 1 : 0)}/${warmupBrowserCount}`);

    const taskPromise = (async () => {
      try {
        if (decision.type === "warmup") {
          return await Promise.race([
            runWarmupSession(profile, profileState),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Warmup timeout (${config.behavior.session_timeout_minutes || 15}dk)`)), SESSION_TIMEOUT)),
          ]);
        } else {
          return await Promise.race([
            runClickSession(profile, profileState, parsedQueries, budgetTracker),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Click timeout (${config.behavior.session_timeout_minutes || 15}dk)`)), SESSION_TIMEOUT)),
          ]);
        }
      } catch (e) {
        console.error(`Task hatası (#${profile.serial || profile.id}): ${e.message.split("\n")[0]}`);
        profileState.transition(profile.id, "cold", { failure: true });
        try { await closeBrowser(profile.id); } catch {}
        return { error: e.message };
      }
    })();
    active.set(taskPromise, { profileId: profile.id, type: decision.type });
    taskPromise.then((r) => {
      if (r && (r.clicked > 0 || (r.hits || 0) > 0 || r.success === true)) lastClickTime = Date.now();
      active.delete(taskPromise);
      console.log(`◀ ${decision.type.toUpperCase()} bitti: #${profile.serial || profile.id} | aktif: ${active.size}`);
    }).catch(() => {
      active.delete(taskPromise);
    });
    return true;
  }

  // İlk batch (stagger ile)
  for (let i = 0; i < totalSlots; i++) {
    if (shouldStop()) break;
    if (i > 0) await sleep(3000 + Math.random() * 3000);
    await resetIfNeeded(profiles);
    if (!launchTask()) break;
  }

  // Continuous queue
  while (!shouldStop()) {
    while (active.size < totalSlots && !shouldStop()) {
      await sleep(2000 + Math.random() * 2000);
      await resetIfNeeded(profiles);
      if (!launchTask()) break;
    }
    if (active.size === 0) {
      await sleep(5000);
      continue;
    }
    await Promise.race([
      Promise.race([...active.keys()]),
      sleep(30000),
    ]);
  }

  console.log(`\nDurma sinyali, kalan ${active.size} task bekleniyor...`);
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
