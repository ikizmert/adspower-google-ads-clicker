const { config } = require("./config");

const SEARCH_URL = "https://www.google.com.tr/search?q=";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomSleep(minSec, maxSec) {
  const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  return sleep(ms * config.behavior.wait_factor);
}

async function closeExtraTabs(browser) {
  const pages = await browser.pages();
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }
  const remaining = await browser.pages();
  if (remaining.length > 0) {
    await remaining[0].goto("about:blank").catch(() => {});
  }
}

async function searchAndClick(browser, query, targetDomains) {
  const page = (await browser.pages())[0] || (await browser.newPage());
  const searchUrl = SEARCH_URL + encodeURIComponent(query);

  console.log(`  Aranıyor: "${query}"`);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomSleep(2, 4);

  // Captcha / "having trouble" kontrolü
  const content = await page.content();
  if (content.includes("having trouble") || content.includes("unusual traffic")) {
    console.log("  ⚠ Google bot algıladı — session atlanıyor");
    return { ads: 0, error: "bot_detected" };
  }

  // Scroll ile tüm reklamları yükle
  await autoScroll(page);
  await randomSleep(1, 2);

  // a[data-pcu] ile reklamları bul
  const adElements = await page.$$("a[data-pcu]");
  console.log(`  Bulunan reklam: ${adElements.length}`);

  if (adElements.length === 0) {
    return { ads: 0, error: null };
  }

  // Hedef domainlere ait reklamları filtrele
  const matchingAds = [];
  for (const ad of adElements) {
    const pcu = await ad.evaluate((el) => el.getAttribute("data-pcu") || "");
    const domain = extractDomain(pcu);
    if (targetDomains.length === 0 || targetDomains.some((d) => domain.includes(d))) {
      matchingAds.push({ element: ad, pcu, domain });
    }
  }

  console.log(
    `  Hedef reklamlar: ${matchingAds.length} (${matchingAds.map((a) => a.domain).join(", ")})`
  );

  let clicked = 0;
  const maxClicks = config.behavior.max_clicks_per_domain;

  for (const ad of matchingAds) {
    if (maxClicks > 0 && clicked >= maxClicks) break;

    try {
      // Reklama tıkla
      await ad.element.click();
      clicked++;
      console.log(`  ✓ Tıklandı: ${ad.domain}`);

      // Reklam sayfasında bekle
      await randomSleep(
        config.behavior.ad_page_min_wait,
        config.behavior.ad_page_max_wait
      );

      // Geri dön
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await randomSleep(2, 3);
    } catch (e) {
      console.log(`  ✗ Tıklama hatası: ${e.message.split("\n")[0]}`);
    }
  }

  // Shopping ads
  if (config.behavior.check_shopping_ads) {
    const shopClicked = await clickShoppingAds(page, targetDomains);
    clicked += shopClicked;
  }

  return { ads: clicked, error: null };
}

async function clickShoppingAds(page, targetDomains) {
  const shopLinks = await page.$$("a.pla-unit, a[data-dtld], .commercial-unit-desktop-rhs a");
  let clicked = 0;

  for (const link of shopLinks) {
    const href = await link.evaluate((el) => el.href || "");
    const domain = extractDomain(href);
    if (targetDomains.length === 0 || targetDomains.some((d) => domain.includes(d))) {
      try {
        await link.click();
        clicked++;
        console.log(`  ✓ Shopping tıklandı: ${domain}`);
        await randomSleep(
          config.behavior.ad_page_min_wait,
          config.behavior.ad_page_max_wait
        );
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await randomSleep(1, 2);
      } catch {
        break;
      }
    }
  }
  return clicked;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const step = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        totalHeight += step;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace("www.", "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

module.exports = { searchAndClick, closeExtraTabs };
