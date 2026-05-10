const { config } = require("./config");
const { logRanking, logNotFound } = require("./ranking-logger");
const clickCounter = require("./click-counter");
const { recordAd, recordHit } = require("./stats");
const fs = require("fs");
const path = require("path");

async function takeScreenshot(page, domain, tag = "") {
  try {
    // Sayfanın yüklenmesini bekle
    await sleep(2000);
    await page.waitForSelector("body", { timeout: 5000 }).catch(() => {});

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
    const dir = path.join(__dirname, "..", "screenshots", domain.replace(/[^a-zA-Z0-9.-]/g, "_"));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${dateStr}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    console.log(`${tag}📸 Screenshot: ${domain}/${dateStr}.png`);
  } catch (e) {
    console.log(`${tag}📸 Screenshot hatası: ${e.message.split("\n")[0]}`);
  }
}

const GOOGLE_URL = "https://www.google.com.tr";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomSleep(minSec, maxSec) {
  const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  return sleep(ms * config.behavior.wait_factor);
}

async function closeExtraTabs(browser) {
  // Yeni boş bir tab aç (about:blank — henüz hiçbir siteye gitme)
  const newTab = await browser.newPage();
  // Diğer tüm tabları kapat (önceki session'dan kalan tablar dahil)
  const pages = await browser.pages();
  for (const p of pages) {
    if (p !== newTab) {
      await p.close().catch(() => {});
    }
  }
  // Tab about:blank'ta kalır — cookie temizleme sonrası doSearch google.com'a gider
}



async function isCaptchaPage(page) {
  try {
    const url = page.url();
    if (url.includes("/sorry") || url.includes("captcha")) return true;
    const content = await page.content();
    if (content.includes("having trouble") || content.includes("unusual traffic")) return true;
    if (content.includes("g-recaptcha") || content.includes("recaptcha")) return true;
    return false;
  } catch {
    return false;
  }
}

// Captcha queue — aynı anda sadece 1 captcha çözülsün (bringToFront çakışmasın)
let captchaQueue = Promise.resolve();

async function solveCaptcha(page, tag = "") {
  const timeoutSec = (config.behavior && config.behavior.captcha_solve_timeout_seconds) || 60;
  const iterations = Math.ceil(timeoutSec / 2.5);

  console.log(`${tag}🔓 Captcha sıraya alındı...`);

  const prev = captchaQueue;
  let release;
  captchaQueue = new Promise((r) => { release = r; });

  // Önceki captcha bitene kadar bekle
  await prev;

  try {
    console.log(`${tag}🔓 Sıra geldi — extension bekleniyor (max ${timeoutSec}sn)...`);
    try { await page.bringToFront(); } catch {}
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await sleep(3000);
    } catch {}

    for (let i = 0; i < iterations; i++) {
      await sleep(2500);
      try {
        const url = page.url();
        if (!url.includes("/sorry") && !url.includes("captcha")) {
          console.log(`${tag}✓ Captcha çözüldü! → ${url}`);
          return true;
        }
      } catch { break; }
    }
    console.log(`${tag}✗ Extension captcha çözemedi (${timeoutSec}sn)`);
    return false;
  } finally {
    release();
  }
}

async function sessionWarmup(page, tag = "") {
  console.log(`${tag}🔥 Warmup başlıyor...`);

  // 1. Facebook
  try {
    await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    await randomSleep(2, 4);
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
      await page.evaluate((amount) => {
        if (typeof window !== "undefined") window.scrollBy({ top: amount, behavior: "smooth" });
      }, 200 + Math.random() * 400).catch(() => {});
      await sleep(1000 + Math.random() * 2000);
    }
    console.log(`${tag}  ✓ Facebook`);
  } catch (e) {
    console.log(`${tag}  ✗ Facebook: ${e.message.split("\n")[0]}`);
  }
  await randomSleep(1, 3);

  // 2. Google News — bir habere tıkla
  try {
    await page.goto("https://news.google.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    await randomSleep(2, 4);
    for (let i = 0; i < 3; i++) {
      await page.evaluate((amount) => {
        if (typeof window !== "undefined") window.scrollBy({ top: amount, behavior: "smooth" });
      }, 200 + Math.random() * 300).catch(() => {});
      await sleep(800 + Math.random() * 1500);
    }
    const newsLink = await page.$('article a[href], c-wiz a[href]');
    if (newsLink) {
      await newsLink.click().catch(() => {});
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await randomSleep(3, 6);
      for (let i = 0; i < 2; i++) {
        await page.evaluate((amount) => {
          if (typeof window !== "undefined") window.scrollBy({ top: amount, behavior: "smooth" });
        }, 200 + Math.random() * 400).catch(() => {});
        await sleep(1000 + Math.random() * 1500);
      }
      console.log(`${tag}  ✓ Google News (habere tıklandı)`);
    } else {
      console.log(`${tag}  ✓ Google News (gezildi)`);
    }
  } catch (e) {
    console.log(`${tag}  ✗ Google News: ${e.message.split("\n")[0]}`);
  }
  await randomSleep(1, 3);

  // 3. Gmail
  try {
    await page.goto("https://mail.google.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    await randomSleep(3, 6);
    await page.evaluate(() => {
      if (typeof window !== "undefined") window.scrollBy({ top: 200, behavior: "smooth" });
    }).catch(() => {});
    await randomSleep(2, 4);
    console.log(`${tag}  ✓ Gmail`);
  } catch (e) {
    console.log(`${tag}  ✗ Gmail: ${e.message.split("\n")[0]}`);
  }
  await randomSleep(1, 2);

  console.log(`${tag}✓ Warmup tamamlandı`);
}



async function clearGoogleCookies(browser) {
  // Sadece google.com domain'indeki cookie'leri sil (NID, 1P_JAR vb. IP referansları)
  const pages = await browser.pages();
  if (pages.length === 0) return;
  const session = await pages[0].target().createCDPSession();
  try {
    const { cookies } = await session.send("Network.getAllCookies");
    const googleCookies = cookies.filter((c) =>
      c.domain.includes("google.com") || c.domain.includes(".google.")
    );
    for (const c of googleCookies) {
      await session.send("Network.deleteCookies", {
        name: c.name,
        domain: c.domain,
        path: c.path,
      }).catch(() => {});
    }
    console.log(`  ${googleCookies.length} Google cookie temizlendi`);
  } catch (e) {
    console.log(`  ✗ Google cookie temizleme hatası: ${e.message.split("\n")[0]}`);
  }
  await session.detach().catch(() => {});
}


async function setupImageBlocking(page) {
  await page.setRequestInterception(true).catch(() => {});
  page.on("request", (req) => {
    const type = req.resourceType();
    const url = req.url();
    // Captcha resimlerini engelleme
    const isCaptchaResource = url.includes("recaptcha") || url.includes("captcha") || url.includes("gstatic.com");
    if ((type === "image" || type === "media" || type === "font") && !isCaptchaResource) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

async function enableImageBlocking(browser) {
  // Mevcut page'lere uygula
  for (const p of await browser.pages()) {
    await setupImageBlocking(p);
  }
  // Yeni açılan page'lere de uygula
  browser.on("targetcreated", async (target) => {
    const p = await target.page().catch(() => null);
    if (p) await setupImageBlocking(p);
  });
}

async function doSearch(browser, _page, query, tag = "") {
  // Yeni sekme aç → Google.com → arama kutusuna yaz → Enter
  try {
    const newPage = await browser.newPage();
    await newPage.goto(GOOGLE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomSleep(1, 2);

    const searchInput = await newPage.$('textarea[name="q"], input[name="q"]');
    if (searchInput) {
      await searchInput.click();
      await randomSleep(0.4, 0.9);
      await searchInput.type(query, { delay: 100 + Math.random() * 150 });
      await randomSleep(0.8, 1.4);
      await Promise.all([
        newPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }),
        newPage.keyboard.press("Enter"),
      ]);
      if (newPage.url().includes("/search")) return newPage;
    }
  } catch (e) {
    console.log(`${tag}[!] Arama başarısız: ${e.message.split("\n")[0]}`);
  }

  // Fallback: URL ile arama
  try {
    console.log(`${tag}[!] URL ile arama deneniyor...`);
    const fallback = await browser.newPage();
    await fallback.goto(
      `${GOOGLE_URL}/search?q=${encodeURIComponent(query)}&hl=tr&gl=tr`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    await randomSleep(1, 2);
    if (fallback.url().includes("/search")) return fallback;
  } catch (e) {
    console.log(`${tag}✗ Arama tamamen başarısız: ${e.message.split("\n")[0]}`);
  }

  return null;
}

async function scanPage(page, adDomains, hitDomains) {
  const ads = [];
  const organics = [];

  // Reklamları bul (hit domainlerini hariç tut)
  const adElements = await page.$$("a[data-pcu]");
  const allAdDomains = new Set();
  for (const el of adElements) {
    const pcu = await el.evaluate((e) => e.getAttribute("data-pcu") || "");
    const domain = extractDomain(pcu);
    if (domain) allAdDomains.add(domain);
    if (domain.includes("google.com") || domain.includes("google.")) continue;
    const isHitDomain = hitDomains.some((d) => domain.includes(d));
    if (isHitDomain) continue;
    if (adDomains.length === 0 || adDomains.some((d) => domain.includes(d))) {
      ads.push({ element: el, domain, pcu });
    }
  }

  // Organik sonuçları bul - sadece gerçek organik, reklam/maps hariç
  const seenHrefs = new Set();
  const organicData = await page.evaluate(() => {
    const AD_URL_PARAMS = ["gclid", "gad_source", "gad_campaignid", "gbraid", "wbraid", "msclkid"];
    const AD_URL_PATTERNS = ["/aclk?", "/url?sa=t&source=web&rct=j&url=", "googleadservices.com"];

    const isAdUrl = (href) => {
      if (AD_URL_PATTERNS.some((p) => href.includes(p))) return true;
      try {
        const u = new URL(href);
        for (const param of AD_URL_PARAMS) {
          if (u.searchParams.has(param)) return true;
        }
      } catch {}
      return false;
    };

    const isInAdContainer = (el) => {
      let p = el;
      while (p) {
        if (!p.tagName) { p = p.parentElement; continue; }
        if (p.id === "tads" || p.id === "bottomads" || p.id === "tadsb") return true;
        if (p.hasAttribute && (p.hasAttribute("data-text-ad") || p.hasAttribute("data-pcu") || p.hasAttribute("data-rw"))) return true;
        const aria = p.getAttribute && p.getAttribute("aria-label");
        if (aria && (aria.toLowerCase().includes("sponsor") || aria.toLowerCase().includes("reklam"))) return true;
        if (p.classList && (p.classList.contains("commercial-unit-desktop-rhs") || p.classList.contains("ads-ad") || p.classList.contains("Sg4azc"))) return true;
        p = p.parentElement;
      }
      return false;
    };

    // Container içinde "Sponsored" / "Sponsorlu" etiketi var mı (Google yasal olarak göstermek zorunda)
    const hasSponsoredLabel = (container) => {
      // Container'ın tüm spans'lerine bak — tek başına "Sponsorlu" / "Sponsored" yazan element
      const small = container.querySelectorAll('span, div');
      for (const s of small) {
        const t = (s.textContent || "").trim();
        // Sadece "Sponsorlu", "Sponsored" tek kelime varsa
        if (t === "Sponsorlu" || t === "Sponsored" || t === "Reklam") return true;
      }
      // Container içinde a[data-pcu] var mı (reklam linki)
      if (container.querySelector('a[data-pcu], [data-text-ad]')) return true;
      return false;
    };

    const containers = document.querySelectorAll('#rso > div, #rso > div.MjjYud, #rso div.g, #rso div[data-snc]');
    const seen = new Set();
    const results = [];
    let pos = 0;
    for (const c of containers) {
      if (isInAdContainer(c)) continue;
      if (hasSponsoredLabel(c)) continue;
      const a = c.querySelector('a[href]:not([data-pcu]):not([href^="javascript"])');
      if (!a) continue;
      const href = a.href;
      if (!href) continue;
      if (href.includes("google.com/maps") || href.includes("maps.google") || href.includes("google.com/local")) continue;
      if (href.includes("google.com")) continue;
      if (isAdUrl(href)) continue; // Tracking parametreli linkler reklamdır
      if (seen.has(href)) continue;
      seen.add(href);
      pos++;
      const u = new URL(href);
      const domain = u.hostname.replace("www.", "").toLowerCase();
      results.push({ href, domain, position: pos });
    }
    return results;
  });

  // Eşleşen organik sonuçları topla, element referanslarını al
  for (const item of organicData) {
    const matchedHit = hitDomains.find((d) => item.domain.includes(d));
    if (!matchedHit) continue;
    if (seenHrefs.has(item.href)) continue;
    seenHrefs.add(item.href);

    // Element handle al
    const handle = await page.evaluateHandle((href) => {
      const links = document.querySelectorAll('#rso a[href]');
      for (const a of links) {
        if (a.href === href) return a;
      }
      return null;
    }, item.href);
    const el = handle.asElement();
    if (el) {
      organics.push({ element: el, domain: item.domain, matchedHit, href: item.href, position: item.position });
    }
  }

  return { ads, organics, totalAds: adElements.length, allAdDomains: [...allAdDomains] };
}

async function clickInNewTab(browser, page, element) {
  try {
    const pagesBefore = (await browser.pages()).length;

    await element.scrollIntoView().catch(() => {});
    await randomSleep(0.4, 0.8);
    const box = await element.boundingBox().catch(() => null);
    if (!box) return null;

    const x = box.x + box.width / 2 + (Math.random() * 6 - 3);
    const y = box.y + box.height / 2 + (Math.random() * 4 - 2);

    await humanMouseMove(page, x, y).catch(() => {});
    await randomSleep(0.2, 0.5);

    // Yöntem 1: Cmd/Ctrl + Click
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    try {
      await page.keyboard.down(modifier);
      await randomSleep(0.05, 0.15);
      await page.mouse.down({ button: "left" });
      await sleep(50 + Math.random() * 100);
      await page.mouse.up({ button: "left" });
      await randomSleep(0.05, 0.15);
      await page.keyboard.up(modifier);
    } catch {}

    await sleep(2500);
    let allPages = await browser.pages().catch(() => []);
    if (allPages.length > pagesBefore) {
      const newTab = allPages[allPages.length - 1];
      await newTab.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      return newTab;
    }

    // Yöntem 2: Middle click
    try {
      await humanMouseMove(page, x, y);
      await randomSleep(0.2, 0.4);
      await page.mouse.click(x, y, { button: "middle" });
    } catch {}

    await sleep(2000);
    allPages = await browser.pages().catch(() => []);
    if (allPages.length > pagesBefore) {
      const newTab = allPages[allPages.length - 1];
      await newTab.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      return newTab;
    }

    // Yöntem 3: JS ile yeni tab
    const href = await element.evaluate((el) => el.href || el.closest("a")?.href || "").catch(() => "");
    if (href && !href.startsWith("javascript")) {
      const newTab = await browser.newPage().catch(() => null);
      if (newTab) {
        await newTab.goto(href, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        return newTab;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

async function searchAndClick(browser, query, adDomains, hitDomains, label = "", sessionAdClicks = {}) {
  let page = (await browser.pages())[0] || (await browser.newPage());
  const tag = label ? `[${label}] ` : "  ";

  console.log(`${tag}Aranıyor: "${query}"`);

  // Yeni sekme aç + address bar'a keyword yaz (en doğal)
  const searchResult = await doSearch(browser, page, query, tag);
  if (!searchResult) {
    return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "search_failed" };
  }
  page = searchResult;
  await randomSleep(1, 2);

  // Captcha tespit → CapSolver ile çöz, çözülemezse session atla
  if (await isCaptchaPage(page)) {
    console.log(`${tag}⚠ Captcha algılandı — çözülmeye çalışılıyor...`);
    const solved = await solveCaptcha(page, tag);
    if (!solved) {
      return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "bot_detected" };
    }
    // Captcha çözüldü — sayfa arama sonuçlarına yönlendiyse devam et
    await randomSleep(2, 4);
    if (!page.url().includes("/search")) {
      // Hala arama sonuçlarında değilse tekrar ara
      console.log(`${tag}Captcha sonrası arama tekrarlanıyor...`);
      const retryPage = await doSearch(browser, page, query, tag);
      if (retryPage) {
        page = retryPage;
      } else {
        return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "search_failed" };
      }
    } else {
      console.log(`${tag}✓ Captcha çözüldü, arama sonuçlarında devam`);
    }
    // Son kontrol
    if (await isCaptchaPage(page)) {
      console.log(`${tag}⚠ Captcha çözümü sonrası hala captcha — session atlanıyor`);
      return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "bot_detected" };
    }
  }

  let totalAdsOnPage = 0;
  let adClicked = 0;
  let hitClicked = 0;
  const maxAdClicksPerDomain = config.behavior.max_clicks_per_domain || (2 + Math.floor(Math.random() * 2));
  const clickedHitDomains = new Set();
  const loggedHitDomains = new Set();
  const rankings = [];
  const maxAdPages = 3;
  const maxHitPages = 5;
  const maxPages = Math.max(maxAdPages, maxHitPages);

  for (let pg = 1; pg <= maxPages; pg++) {
    await autoScroll(page);
    await randomSleep(1, 2);

    const { ads, organics, totalAds, allAdDomains } = await scanPage(page, adDomains, hitDomains);
    totalAdsOnPage += totalAds;

    const searchAds = pg <= maxAdPages;
    const searchHits = pg <= maxHitPages && hitDomains.some((d) => !clickedHitDomains.has(d));

    const adDomainsList = allAdDomains.length > 0 ? ` [${allAdDomains.join(", ")}]` : "";
    console.log(`${tag}[Sayfa ${pg}] Toplam reklam: ${totalAds}${adDomainsList} | Hedef reklam: ${searchAds ? ads.length : "atlandı"} | Organik hit: ${searchHits ? organics.length : "atlandı"}`);

    // Reklamlara tıkla (yeni sekmede) - domain başına max 2-3
    if (searchAds) {
      for (const ad of ads) {
        const domainCount = sessionAdClicks[ad.domain] || 0;
        if (domainCount >= maxAdClicksPerDomain) continue;
        try {
          // Tıklamadan önce screenshot (mouse reklam üstünde)
          if (config.behavior.screenshot_on_click) {
            try {
              await ad.element.scrollIntoView().catch(() => {});
              const box = await ad.element.boundingBox().catch(() => null);
              if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
            } catch {}
            await takeScreenshot(page, ad.domain, tag);
          }
          const newTab = await clickInNewTab(browser, page, ad.element);
          if (newTab) {
            adClicked++;
            sessionAdClicks[ad.domain] = domainCount + 1;
            try { recordAd(ad.domain); } catch {}
            try { clickCounter.record(ad.domain, "ads"); } catch {}
            const tabUrl = (() => { try { return newTab.url(); } catch { return "?"; } })();
            console.log(`${tag}✓ Reklam tıklandı: ${ad.domain} (${sessionAdClicks[ad.domain]}/${maxAdClicksPerDomain}) → ${tabUrl}`);
            try { await browseAdPage(newTab, tag); } catch {}
            try { await newTab.close(); } catch {}
            await randomSleep(1, 2);
          } else {
            console.log(`${tag}✗ Reklam yeni sekmede açılamadı: ${ad.domain}`);
          }
        } catch (e) {
          console.log(`${tag}✗ Reklam tıklama hatası: ${e.message.split("\n")[0]}`);
        }
      }
    }

    // Bulunan tüm organik hit domain'lere tıkla (her domain için bir kez) - sadece pg <= 5
    if (searchHits) {
    for (const hit of organics) {
      if (clickedHitDomains.has(hit.matchedHit)) continue;
      const globalPosition = (pg - 1) * 10 + hit.position;

      if (!loggedHitDomains.has(hit.matchedHit)) {
        loggedHitDomains.add(hit.matchedHit);
        rankings.push({ domain: hit.domain, page: pg, position: hit.position, globalPosition });
        console.log(`${tag}🎯 Organik: ${hit.domain} — Sayfa ${pg}, Sıra ${hit.position} (genel: ${globalPosition})`);
      }

      try {
        // Tıklamadan önce screenshot
        if (config.behavior.screenshot_on_click) {
          try {
            await hit.element.scrollIntoView().catch(() => {});
            const box = await hit.element.boundingBox().catch(() => null);
            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
          } catch {}
          await takeScreenshot(page, hit.domain, tag);
        }
        const newTab = await clickInNewTab(browser, page, hit.element);
        if (newTab) {
          clickedHitDomains.add(hit.matchedHit);
          hitClicked++;
          try { recordHit(hit.domain); } catch {}
          try { clickCounter.record(hit.domain, "hits"); } catch {}
          const tabUrl = (() => { try { return newTab.url(); } catch { return "?"; } })();
          console.log(`${tag}✓ Organik tıklandı: ${hit.domain} → ${tabUrl}`);
          try { logRanking({ query, domain: hit.domain, page: pg, position: globalPosition, clicked: true }); } catch {}
          try { await browseAdPage(newTab, tag); } catch {}
          // Organik sekmesi session sonuna kadar açık kalır
          await randomSleep(1, 2);
        } else {
          console.log(`${tag}✗ Yeni sekmede açılamadı: ${hit.domain}`);
          try { logRanking({ query, domain: hit.domain, page: pg, position: globalPosition, clicked: false }); } catch {}
          clickedHitDomains.add(hit.matchedHit);
        }
      } catch (e) {
        console.log(`${tag}✗ Tıklama hatası: ${e.message.split("\n")[0]}`);
        try { logRanking({ query, domain: hit.domain, page: pg, position: globalPosition, clicked: false }); } catch {}
        clickedHitDomains.add(hit.matchedHit);
      }
    }
    } // searchHits

    // Çıkış kontrolü:
    // - Reklam: pg >= 3 olunca aramayı bırak (her sayfada gördüğünü tıklar, sınır yok)
    // - Hit: tüm hit domainler tıklandı veya pg >= 5
    const adSearchDone = adDomains.length === 0 || pg >= maxAdPages;
    const allHitsDone = hitDomains.length === 0 || hitDomains.every((d) => clickedHitDomains.has(d));
    if (adSearchDone && allHitsDone) break;

    // Sonraki sayfaya git
    if (pg < maxPages) {
      const nextBtn = await page.$('a#pnnext, a[aria-label="Next"], a[aria-label="Sonraki"], td.d6cvqb a[id="pnnext"]');
      if (!nextBtn) {
        console.log(`${tag}Sonraki sayfa butonu bulunamadı`);
        break;
      }
      console.log(`${tag}Sayfa ${pg + 1}'e geçiliyor...`);
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

  // Hiç bulunamayan hit domainleri logla
  for (const d of hitDomains) {
    if (!loggedHitDomains.has(d)) {
      logNotFound({ query, domain: d, pagesSearched: maxPages });
      console.log(`${tag}✗ Bulunamadı: ${d} (${maxPages} sayfa)`);
    }
  }

  const notFound = hitDomains.filter((d) => !loggedHitDomains.has(d));
  return { ads: adClicked, hits: hitClicked, totalAdsOnPage, rankings, notFound, error: null };
}

async function humanMouseMove(page, targetX, targetY) {
  try {
    const steps = 8 + Math.floor(Math.random() * 12);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t);
      const jitterX = (Math.random() - 0.5) * 6;
      const jitterY = (Math.random() - 0.5) * 4;
      const x = targetX * ease + jitterX;
      const y = targetY * ease + jitterY;
      await page.mouse.move(x, y).catch(() => {});
      await sleep(15 + Math.random() * 30);
    }
    await page.mouse.move(targetX, targetY).catch(() => {});
  } catch {}
}

async function browseAdPage(page, tag = "") {
  const minWait = config.behavior.ad_page_min_wait;
  const maxWait = config.behavior.ad_page_max_wait;
  const totalTime = (minWait + Math.random() * (maxWait - minWait)) * 1000;
  const HARD_TIMEOUT = totalTime + 10000; // ekstra 10s tolerans
  const startTime = Date.now();

  // Page evaluate'lere timeout ile sarmal — askıda kalmasın
  const safeEval = (fn, arg) =>
    Promise.race([
      page.evaluate(fn, arg),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]).catch(() => null);

  let scrollCount = 0;
  const browse = async () => {
    await sleep(1500 + Math.random() * 1000);

    while (Date.now() - startTime < totalTime) {
      const scrollAmount = 50 + Math.floor(Math.random() * 250);
      const scrolled = await safeEval((amount) => {
        if (typeof window !== "undefined") { window.scrollBy({ top: amount, behavior: "smooth" }); return true; }
        return false;
      }, scrollAmount);
      if (scrolled) scrollCount++;

      if (Math.random() < 0.3) {
        await sleep(2000 + Math.random() * 3000);
      } else {
        await sleep(800 + Math.random() * 1500);
      }

      if (Math.random() < 0.25) {
        const vw = await safeEval(() => window.innerWidth) || 1280;
        const vh = await safeEval(() => window.innerHeight) || 720;
        await humanMouseMove(page, Math.random() * vw * 0.8 + vw * 0.1, Math.random() * vh * 0.6 + vh * 0.2).catch(() => {});
      }

      if (Math.random() < 0.1) {
        const upAmount = 30 + Math.floor(Math.random() * 100);
        await safeEval((amount) => {
          if (typeof window !== "undefined") window.scrollBy({ top: -amount, behavior: "smooth" });
        }, upAmount);
        await sleep(500 + Math.random() * 800);
      }
    }
  };

  try {
    await Promise.race([
      browse(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("browseAdPage hard timeout")), HARD_TIMEOUT)),
    ]);
    console.log(`${tag}📄 Sitede ${(totalTime / 1000).toFixed(0)}s gezildi (${scrollCount} scroll)`);
  } catch (e) {
    console.log(`${tag}⚠ browseAdPage timeout: ${e.message.split("\n")[0]}`);
  }
}

async function autoScroll(page) {
  const scrollHeight = await page.evaluate(() => {
    return document.body ? document.body.scrollHeight : 0;
  }).catch(() => 0);
  if (!scrollHeight) return;

  let scrolled = 0;
  while (scrolled < scrollHeight) {
    const step = 150 + Math.floor(Math.random() * 250);
    await page.evaluate((amount) => {
      if (typeof window !== "undefined") window.scrollBy({ top: amount, behavior: "smooth" });
    }, step).catch(() => {});
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

async function clearAllStorage(browser) {
  // CDP üzerinden tüm cookie + storage temizle
  const pages = await browser.pages();
  if (pages.length === 0) return;
  const session = await pages[0].target().createCDPSession();
  try {
    // Tüm cookie'leri sil (sadece google değil)
    await session.send("Network.clearBrowserCookies").catch(() => {});
    // Cache temizle
    await session.send("Network.clearBrowserCache").catch(() => {});
    // localStorage / sessionStorage / IndexedDB için Storage.clearDataForOrigin "*"
    await session.send("Storage.clearDataForOrigin", {
      origin: "*",
      storageTypes: "all",
    }).catch(() => {});
    console.log(`  ✓ Storage temizlendi (cookies + cache + localStorage + IndexedDB)`);
  } catch (e) {
    console.log(`  ✗ Storage temizleme hatası: ${e.message.split("\n")[0]}`);
  }
  await session.detach().catch(() => {});
}

module.exports = { searchAndClick, closeExtraTabs, enableImageBlocking, clearGoogleCookies, sessionWarmup, clearAllStorage };
