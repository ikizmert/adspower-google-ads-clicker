const { config } = require("./config");

const GOOGLE_URL = "https://www.google.com";

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

async function doSearch(page, query) {
  // Yöntem 1: Google'a git, input'a yaz, Enter bas
  try {
    await page.goto(GOOGLE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomSleep(1, 2);

    const searchInput = await page.$('textarea[name="q"], input[name="q"]');
    if (searchInput) {
      await searchInput.click({ clickCount: 3 });
      await randomSleep(0.3, 0.6);
      await searchInput.type(query, { delay: 50 + Math.random() * 100 });
      await randomSleep(0.5, 1);

      await page.keyboard.press("Escape");
      await randomSleep(0.3, 0.5);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }),
        page.keyboard.press("Enter"),
      ]);
      if (page.url().includes("/search")) return true;
    }
  } catch (e) {
    console.log(`  [!] Yazarak arama başarısız: ${e.message.split("\n")[0]}`);
  }

  // Yöntem 2: Doğrudan URL ile arama
  try {
    console.log(`  [!] URL ile arama deneniyor...`);
    await page.goto(
      `${GOOGLE_URL}/search?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    await randomSleep(1, 2);
    return page.url().includes("/search");
  } catch (e) {
    console.log(`  ✗ Arama tamamen başarısız: ${e.message.split("\n")[0]}`);
    return false;
  }
}

async function searchAndClick(browser, query, targetDomains) {
  const page = (await browser.pages())[0] || (await browser.newPage());

  console.log(`  Aranıyor: "${query}"`);

  // Google'a git ve arama yap
  const searched = await doSearch(page, query);
  if (!searched) {
    return { ads: 0, totalAdsOnPage: 0, error: "search_failed" };
  }
  await randomSleep(1, 2);

  // Captcha / "having trouble" kontrolü
  const content = await page.content();
  if (content.includes("having trouble") || content.includes("unusual traffic")) {
    console.log("  ⚠ Google bot algıladı — session atlanıyor");
    return { ads: 0, totalAdsOnPage: 0, error: "bot_detected" };
  }

  let totalAdsOnPage = 0;

  // Reklamları bul, bulamazsa 2. ve 3. sayfaya bak
  let matchingAds = [];
  const maxPages = 3;

  for (let pg = 1; pg <= maxPages; pg++) {
    await autoScroll(page);
    await randomSleep(1, 2);

    // Desktop: a[data-pcu], Mobil: a[data-rw], a[data-ved] içinde sponsorlu olanlar
    const adElements = await page.$$("a[data-pcu]");
    const mobileAdElements = adElements.length === 0
      ? await page.$$('#tads a[data-ved], #bottomads a[data-ved], [data-text-ad] a, a[data-rw]')
      : [];
    const allAds = [...adElements, ...mobileAdElements];
    totalAdsOnPage += allAds.length;
    console.log(`  [Sayfa ${pg}] Bulunan reklam: ${allAds.length}`);

    for (const ad of allAds) {
      const pcu = await ad.evaluate((el) => el.getAttribute("data-pcu") || el.getAttribute("data-rw") || el.href || "");
      const domain = extractDomain(pcu);
      if (targetDomains.length === 0 || targetDomains.some((d) => domain.includes(d))) {
        matchingAds.push({ element: ad, pcu, domain });
      }
    }

    if (matchingAds.length > 0) break;

    // Sonraki sayfaya git
    if (pg < maxPages) {
      const nextBtn = await page.$('a#pnnext, a[aria-label="Next"], a[aria-label="Sonraki"], td.d6cvqb a[id="pnnext"], a.nBDE1b.G5eFlf, footer a[aria-label="Page 2"]');
      if (!nextBtn) {
        console.log(`  Sonraki sayfa butonu bulunamadı`);
        break;
      }
      console.log(`  Hedef reklam yok, sayfa ${pg + 1}'e geçiliyor...`);
      await humanMouseMove(page, 0, 0);
      const nbox = await nextBtn.boundingBox();
      if (nbox) {
        await humanMouseMove(page, nbox.x + nbox.width / 2, nbox.y + nbox.height / 2);
        await randomSleep(0.2, 0.5);
        await page.mouse.click(nbox.x + nbox.width / 2, nbox.y + nbox.height / 2);
      } else {
        await nextBtn.click();
      }
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await randomSleep(2, 3);
    }
  }

  if (matchingAds.length === 0) {
    console.log(`  Hedef reklam bulunamadı (${maxPages} sayfa kontrol edildi)`);
    return { ads: 0, totalAdsOnPage, error: null };
  }

  console.log(
    `  Hedef reklamlar: ${matchingAds.length} (${matchingAds.map((a) => a.domain).join(", ")})`
  );

  let clicked = 0;
  const maxClicks = config.behavior.max_clicks_per_domain;

  for (let i = 0; i < matchingAds.length; i++) {
    if (maxClicks > 0 && clicked >= maxClicks) break;

    const ad = matchingAds[i];
    try {
      // Element'e scroll yap ve tıkla
      const box = await ad.element.boundingBox();
      if (!box) {
        console.log(`  ✗ Reklam görünür değil: ${ad.domain}`);
        continue;
      }
      await ad.element.scrollIntoView();
      await randomSleep(0.3, 0.6);
      const freshBox = await ad.element.boundingBox();
      if (!freshBox) {
        console.log(`  ✗ Scroll sonrası reklam kayboldu: ${ad.domain}`);
        continue;
      }
      const x = freshBox.x + freshBox.width / 2 + (Math.random() * 6 - 3);
      const y = freshBox.y + freshBox.height / 2 + (Math.random() * 4 - 2);
      await humanMouseMove(page, x, y);
      await randomSleep(0.1, 0.3);
      const urlBefore = page.url();
      await page.mouse.click(x, y);

      // Sayfanın değişmesini bekle
      try {
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 });
      } catch {
        // Navigation event olmadıysa URL değişmiş mi kontrol et
        await sleep(2000);
      }

      const urlAfter = page.url();
      if (urlAfter === urlBefore || urlAfter.includes("/search")) {
        console.log(`  ✗ Sayfa değişmedi, tıklama başarısız: ${ad.domain}`);
        continue;
      }

      clicked++;
      console.log(`  ✓ Tıklandı: ${ad.domain} → ${urlAfter}`);

      // Reklam sitesinde insan gibi gezin
      await browseAdPage(page);

      // Google'a geri dön
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await randomSleep(2, 3);

      // Sonraki tıklama için reklamları tekrar bul (element referansları kaybolmuş olabilir)
      if (i < matchingAds.length - 1) {
        const freshAds = await page.$$("a[data-pcu]");
        for (let j = i + 1; j < matchingAds.length; j++) {
          const targetPcu = matchingAds[j].pcu;
          for (const fa of freshAds) {
            const pcu = await fa.evaluate((el) => el.getAttribute("data-pcu") || "");
            if (pcu === targetPcu) {
              matchingAds[j].element = fa;
              break;
            }
          }
        }
      }
    } catch (e) {
      console.log(`  ✗ Tıklama hatası: ${e.message.split("\n")[0]}`);
    }
  }

  // Shopping ads
  if (config.behavior.check_shopping_ads) {
    const shopClicked = await clickShoppingAds(page, targetDomains);
    clicked += shopClicked;
  }

  return { ads: clicked, totalAdsOnPage, error: null };
}

async function humanMouseMove(page, targetX, targetY) {
  const start = await page.evaluate(() => ({ x: 0, y: 0 }));
  const steps = 8 + Math.floor(Math.random() * 12);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const jitterX = (Math.random() - 0.5) * 6;
    const jitterY = (Math.random() - 0.5) * 4;
    const x = start.x + (targetX - start.x) * ease + jitterX;
    const y = start.y + (targetY - start.y) * ease + jitterY;
    await page.mouse.move(x, y);
    await sleep(15 + Math.random() * 30);
  }
  await page.mouse.move(targetX, targetY);
}

async function browseAdPage(page) {
  const minWait = config.behavior.ad_page_min_wait;
  const maxWait = config.behavior.ad_page_max_wait;
  const totalTime = (minWait + Math.random() * (maxWait - minWait)) * 1000;
  const startTime = Date.now();

  await sleep(1500 + Math.random() * 1000);

  while (Date.now() - startTime < totalTime) {
    // Değişken scroll miktarı
    const scrollAmount = 50 + Math.floor(Math.random() * 250);
    await page.evaluate((amount) => {
      window.scrollBy({ top: amount, behavior: "smooth" });
    }, scrollAmount);

    // Bazen daha uzun dur (okuma simülasyonu)
    if (Math.random() < 0.3) {
      await sleep(2000 + Math.random() * 3000);
    } else {
      await sleep(800 + Math.random() * 1500);
    }

    // Bazen mouse'u rastgele hareket ettir
    if (Math.random() < 0.25) {
      const vw = await page.evaluate(() => window.innerWidth);
      const vh = await page.evaluate(() => window.innerHeight);
      await humanMouseMove(page, Math.random() * vw * 0.8 + vw * 0.1, Math.random() * vh * 0.6 + vh * 0.2);
    }

    // Bazen yukarı scroll
    if (Math.random() < 0.1) {
      const upAmount = 30 + Math.floor(Math.random() * 100);
      await page.evaluate((amount) => {
        window.scrollBy({ top: -amount, behavior: "smooth" });
      }, upAmount);
      await sleep(500 + Math.random() * 800);
    }
  }

  console.log(`  📄 Sitede ${(totalTime / 1000).toFixed(0)}s gezildi`);
}

async function clickShoppingAds(page, targetDomains) {
  const shopLinks = await page.$$("a.pla-unit, a[data-dtld], .commercial-unit-desktop-rhs a");
  let clicked = 0;

  for (const link of shopLinks) {
    const href = await link.evaluate((el) => el.href || "");
    const domain = extractDomain(href);
    if (targetDomains.length === 0 || targetDomains.some((d) => domain.includes(d))) {
      try {
        const box = await link.boundingBox();
        if (!box) continue;
        await link.scrollIntoView();
        await randomSleep(0.3, 0.5);
        const x = box.x + box.width / 2 + (Math.random() * 6 - 3);
        const y = box.y + box.height / 2 + (Math.random() * 4 - 2);
        await page.mouse.click(x, y);
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
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  let scrolled = 0;
  while (scrolled < scrollHeight) {
    const step = 150 + Math.floor(Math.random() * 250);
    await page.evaluate((amount) => {
      window.scrollBy({ top: amount, behavior: "smooth" });
    }, step);
    scrolled += step;
    if (Math.random() < 0.2) {
      await sleep(800 + Math.random() * 1200);
    } else {
      await sleep(300 + Math.random() * 500);
    }
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace("www.", "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

module.exports = { searchAndClick, closeExtraTabs };
