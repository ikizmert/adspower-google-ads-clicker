const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { config } = require("./config");
const { checkStatus, openBrowser, closeBrowser } = require("./adspower");

const COOKIES_PATH = path.join(__dirname, "..", "pilot-cookies.json");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const pilotId = config.adspower.pilot_profile_id;
  if (!pilotId) {
    console.error("config.adspower.pilot_profile_id boş!");
    process.exit(1);
  }

  const alive = await checkStatus().catch(() => false);
  if (!alive) {
    console.error("AdsPower çalışmıyor!");
    process.exit(1);
  }

  console.log(`Pilot profil açılıyor: ${pilotId}`);
  const { wsEndpoint } = await openBrowser(pilotId);
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

  // Cookie'lerin yüklenmesi için biraz bekle
  await sleep(3000);

  const pages = await browser.pages();
  const page = pages[0];
  const session = await page.target().createCDPSession();
  const { cookies } = await session.send("Network.getAllCookies");
  await session.detach().catch(() => {});

  console.log(`${cookies.length} cookie bulundu, kaydediliyor...`);
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log(`Kaydedildi: ${COOKIES_PATH}`);

  // Domain özeti
  const domains = {};
  for (const c of cookies) {
    domains[c.domain] = (domains[c.domain] || 0) + 1;
  }
  for (const [d, n] of Object.entries(domains).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${d}: ${n}`);
  }

  browser.disconnect();
  await closeBrowser(pilotId);
  console.log("Pilot kapatıldı.");
}

main().catch((e) => {
  console.error("Hata:", e.message);
  process.exit(1);
});
