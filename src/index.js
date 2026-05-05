const puppeteer = require("puppeteer-core");
const { config, queries, parseQuery } = require("./config");
const { checkStatus, openBrowser, closeBrowser, listProfiles } = require("./adspower");
const { searchAndClick, closeExtraTabs } = require("./searcher");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  // AdsPower bağlantı kontrolü
  const alive = await checkStatus().catch(() => false);
  if (!alive) {
    console.error("AdsPower çalışmıyor! Önce AdsPower'ı başlatın.");
    process.exit(1);
  }

  // Profil seç
  let profileId = config.adspower.profile_id;
  if (!profileId) {
    const profiles = await listProfiles();
    if (profiles.length === 0) {
      console.error("AdsPower'da profil bulunamadı!");
      process.exit(1);
    }
    profileId = profiles[0].id;
    console.log(`Profil otomatik seçildi: ${profiles[0].name} (${profileId})`);
  }

  const maxRun = config.behavior.max_run;
  const parsedQueries = queries.map(parseQuery);

  console.log(`\nKampanya başlıyor`);
  console.log(`  Profil: ${profileId}`);
  console.log(`  Max run: ${maxRun}`);
  console.log(`  Query sayısı: ${parsedQueries.length}`);
  console.log("");

  let totalClicked = 0;
  let totalFailed = 0;
  let completed = 0;

  while (completed < maxRun) {
    // Browser aç
    console.log(`--- Session ${completed + 1}/${maxRun} ---`);
    let browser;
    try {
      const { wsEndpoint } = await openBrowser(profileId);
      browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    } catch (e) {
      console.error(`Browser açılamadı: ${e.message}`);
      completed++;
      totalFailed++;
      continue;
    }

    // Eski tabları kapat
    await closeExtraTabs(browser);

    // Bu session'da çalışacak query'leri seç
    const remaining = maxRun - completed;
    const sessionSize = Math.min(parsedQueries.length, remaining);
    const sessionQueries = shuffle([...parsedQueries]).slice(0, sessionSize);

    let sessionAborted = false;

    for (const q of sessionQueries) {
      if (sessionAborted) break;

      const result = await searchAndClick(browser, q.search, q.domains);

      if (result.error === "bot_detected") {
        totalFailed++;
        sessionAborted = true;
      } else if (result.ads > 0) {
        totalClicked += result.ads;
      } else {
        totalFailed++;
      }

      completed++;
      if (completed >= maxRun) break;

      // Query'ler arası bekleme
      if (!sessionAborted) {
        const wait = (5 + Math.random() * 10) * config.behavior.wait_factor;
        console.log(`  ${wait.toFixed(1)}s bekleniyor...\n`);
        await sleep(wait * 1000);
      }
    }

    // Browser kapat
    try {
      browser.disconnect();
      await closeBrowser(profileId);
    } catch {}

    console.log(
      `Session bitti | tamamlanan: ${completed}/${maxRun} | tıklanan: ${totalClicked} | başarısız: ${totalFailed}\n`
    );

    // Session arası bekleme
    if (completed < maxRun) {
      const wait = (3 + Math.random() * 5) * config.behavior.wait_factor;
      await sleep(wait * 1000);
    }
  }

  console.log(`\n=== Kampanya tamamlandı ===`);
  console.log(`  Toplam tıklanan: ${totalClicked}`);
  console.log(`  Toplam başarısız: ${totalFailed}`);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

run().catch((e) => {
  console.error("Kritik hata:", e.message);
  process.exit(1);
});
