const { config } = require("./config");
const { logRanking, logNotFound } = require("./ranking-logger");
const clickCounter = require("./click-counter");
const { recordAd, recordHit } = require("./stats");
const captchaSolver = require("./captcha-solver");
const fs = require("fs");
const path = require("path");

const FILLER_QUERIES_PATH = path.join(__dirname, "..", "filler-queries.txt");

function loadFillerQueries() {
  try {
    return fs.readFileSync(FILLER_QUERIES_PATH, "utf-8")
      .split("\n").map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

function pickRandomQueries(arr, count) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function slugify(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i")
    .replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

async function takeScreenshot(page, domain, tag = "", meta = {}) {
  try {
    if (!page || page.isClosed()) {
      console.log(`${tag}📸 Screenshot iptal: page kapalı (entry)`);
      return;
    }
    const url = page.url();
    console.log(`${tag}📸 Screenshot çağrıldı: domain=${domain} url=${url.substring(0, 60)}`);

    await sleep(2000);

    if (page.isClosed()) {
      console.log(`${tag}📸 Screenshot iptal: page sleep sonrası kapandı`);
      return;
    }
    await page.waitForSelector("body", { timeout: 5000 }).catch(() => {});

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const monthDir = `${yyyy}-${mm}`;
    const dayDir = `${yyyy}-${mm}-${dd}`;
    const timeStr = `${hh}-${mi}-${ss}`;
    const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, "_");
    const dir = path.join(__dirname, "..", "screenshots", monthDir, dayDir, safeDomain);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let suffix = "";
    if (meta.query) suffix += `_${slugify(meta.query)}`;
    if (meta.page) suffix += `_p${meta.page}`;
    if (meta.position) suffix += `_s${meta.position}`;
    const filePath = path.join(dir, `${timeStr}${suffix}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    console.log(`${tag}📸 Screenshot kaydedildi: ${monthDir}/${dayDir}/${safeDomain}/${timeStr}${suffix}.png`);
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

async function solveCaptcha(page, proxyApplied, tag = "") {
  return await captchaSolver.solveCaptcha(page, proxyApplied, tag);
}

async function doFillerSearches(browser, count, proxyApplied, tag = "") {
  const fillers = loadFillerQueries();
  if (fillers.length === 0) {
    console.log(`${tag}⚠ filler-queries.txt boş veya bulunamadı`);
    return { hadCaptcha: false };
  }
  const picks = pickRandomQueries(fillers, count);
  console.log(`${tag}🌿 Filler aramalar (${picks.length}): ${picks.join(", ")}`);

  for (const fq of picks) {
    let page;
    try {
      page = await doSearch(browser, null, fq, tag);
      if (!page) continue;

      // Captcha kontrolü — solve_continue politikası
      if (await isCaptchaPage(page)) {
        if (config.behavior.captcha_action !== "solve_continue") {
          console.log(`${tag}⚠ Filler "${fq}"da captcha (captcha_action=abort) → session terk`);
          return { hadCaptcha: true, solved: false };
        }
        console.log(`${tag}⚠ Filler "${fq}"da captcha — çözmeye çalışılıyor`);
        const solved = await solveCaptcha(page, proxyApplied, tag);
        if (!solved) {
          console.log(`${tag}✗ Filler captcha çözülemedi → session terk`);
          return { hadCaptcha: true, solved: false };
        }
      }

      // İlk organik sonuca tıkla, kısa gez, kapat
      await randomSleep(1, 2);
      const firstOrganic = await page.$('#rso a[href]:not([data-pcu]):not([href*="google.com"])');
      if (firstOrganic) {
        try {
          const newTab = await clickInNewTab(browser, page, firstOrganic);
          if (newTab) {
            await sleep(5000 + Math.random() * 3000);
            await newTab.close().catch(() => {});
          }
        } catch {}
      }
    } catch (e) {
      console.log(`${tag}✗ Filler "${fq}" hatası: ${e.message.split("\n")[0]}`);
    } finally {
      try { if (page) await page.close(); } catch {}
    }
  }
  return { hadCaptcha: false };
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

  // 2. Google News (captcha riski yüksek nokta)
  try {
    await page.goto("https://news.google.com", { waitUntil: "domcontentloaded", timeout: 20000 });
    if (await isCaptchaPage(page)) {
      console.log(`${tag}  ⚠ Google News'de captcha → warmup terk`);
      return { success: false, hadCaptcha: true };
    }
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
    if (await isCaptchaPage(page)) {
      console.log(`${tag}  ⚠ Gmail'de captcha → warmup terk`);
      return { success: false, hadCaptcha: true };
    }
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
  return { success: true, hadCaptcha: false };
}



async function clearAllGoogleCookies(browser) {
  // Click session sonunda çağrılır — TÜM google.com cookies silinir
  // (mevcut clearGoogleCookies sadece tracking cookies siliyordu)
  const pages = await browser.pages();
  if (pages.length === 0) return;
  const session = await pages[0].target().createCDPSession();
  try {
    const { cookies } = await session.send("Network.getAllCookies");
    const toDelete = cookies.filter((c) =>
      c.domain.includes("google.com") || c.domain.includes(".google.")
    );
    for (const c of toDelete) {
      await session.send("Network.deleteCookies", {
        name: c.name,
        domain: c.domain,
        path: c.path,
      }).catch(() => {});
    }
    console.log(`  ${toDelete.length} Google cookie temizlendi (full wipe)`);
  } catch (e) {
    console.log(`  ✗ clearAllGoogleCookies hatası: ${e.message.split("\n")[0]}`);
  }
  await session.detach().catch(() => {});
}

async function clearGoogleCookies(browser) {
  // Sadece IP'ye bağlı tracking cookie'leri sil — oturum cookie'lerini bırak
  // NID, 1P_JAR: IP referanslı, silinince captcha tetiklenmiyor
  // SOCS, CONSENT, SID, HSID, SSID: oturum/fingerprint, bırakılınca captcha yok
  const TRACKING_COOKIES = ["NID", "1P_JAR", "__Secure-1PSID", "__Secure-3PSID", "APISID"];
  const pages = await browser.pages();
  if (pages.length === 0) return;
  const session = await pages[0].target().createCDPSession();
  try {
    const { cookies } = await session.send("Network.getAllCookies");
    const toDelete = cookies.filter((c) =>
      (c.domain.includes("google.com") || c.domain.includes(".google.")) &&
      TRACKING_COOKIES.includes(c.name)
    );
    for (const c of toDelete) {
      await session.send("Network.deleteCookies", {
        name: c.name,
        domain: c.domain,
        path: c.path,
      }).catch(() => {});
    }
    console.log(`  ${toDelete.length} tracking cookie temizlendi (${TRACKING_COOKIES.join(",")})`);
  } catch (e) {
    console.log(`  ✗ Cookie temizleme hatası: ${e.message.split("\n")[0]}`);
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

async function humanTypeAndSubmit(page, query, tag = "") {
  // Find the search input
  const searchInput = await page.$('textarea[name="q"], input[name="q"]');
  if (!searchInput) return false;

  // Scroll to top so input is visible
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await randomSleep(0.3, 0.7);

  // Mouse move toward input (human-like)
  const box = await searchInput.boundingBox().catch(() => null);
  if (box) {
    const targetX = box.x + box.width / 2 + (Math.random() - 0.5) * 40;
    const targetY = box.y + box.height / 2 + (Math.random() - 0.5) * 8;
    await humanMouseMove(page, targetX, targetY).catch(() => {});
    await randomSleep(0.1, 0.3);
  }

  // Click + clear existing content (triple-click selects all, Backspace clears)
  await searchInput.click({ clickCount: 3 }).catch(() => {});
  await randomSleep(0.15, 0.35);
  await page.keyboard.press("Backspace").catch(() => {});
  await randomSleep(0.25, 0.55);

  // Variable type tempo: Türkçe characters slightly slower, occasional thinking pauses, occasional fast bursts
  for (const ch of query) {
    let delay = 70 + Math.random() * 130;  // baseline 70-200ms
    if (/[şçığüöŞÇİĞÜÖ]/.test(ch)) delay += 40 + Math.random() * 80;  // Türkçe char penalty
    if (ch === " ") delay += 30 + Math.random() * 90;  // word boundary slower
    if (Math.random() < 0.07) delay += 250 + Math.random() * 350;  // ~7% chance of "thinking pause"
    if (Math.random() < 0.10) delay = 30 + Math.random() * 40;  // ~10% chance of fast burst
    await page.keyboard.type(ch);
    await sleep(delay);
  }

  // Wait for dropdown to appear
  await randomSleep(0.9, 1.5);

  // Try clicking a dropdown suggestion (70% of the time)
  if (Math.random() < 0.70) {
    try {
      // Google's autosuggest dropdown selectors (multiple variations seen in production)
      const suggestions = await page.$$('ul[role="listbox"] li[role="presentation"], ul[role="listbox"] [role="option"], [role="listbox"] li');
      const visible = [];
      for (const s of suggestions) {
        const sbox = await s.boundingBox().catch(() => null);
        if (sbox && sbox.width > 50 && sbox.height > 10) visible.push({ el: s, box: sbox });
      }
      if (visible.length > 0) {
        // Pick top-3 randomly (most natural — users usually pick from first few)
        const idx = Math.floor(Math.random() * Math.min(3, visible.length));
        const target = visible[idx];
        await humanMouseMove(page, target.box.x + target.box.width / 2, target.box.y + target.box.height / 2).catch(() => {});
        await randomSleep(0.2, 0.45);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }),
          target.el.click(),
        ]);
        console.log(`${tag}  dropdown onerisi tiklandi (#${idx + 1}/${visible.length})`);
        return true;
      }
    } catch (e) {
      // Dropdown click failed → fallback to Enter below
      console.log(`${tag}  [!] Dropdown click basarisiz: ${e.message.split("\n")[0]} — Enter ile devam`);
    }
  }

  // Fallback / 30% of the time: press Enter
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }),
      page.keyboard.press("Enter"),
    ]);
    return true;
  } catch (e) {
    return false;
  }
}

async function doSearch(browser, page, query, tag = "") {
  // 1. Mevcut sekme Google search sayfasındaysa aynı sekmede yeni arama yap
  if (page && !page.isClosed()) {
    try {
      const url = page.url();
      const onSearchPage = url.includes("google.") && url.includes("/search");
      if (onSearchPage) {
        const ok = await humanTypeAndSubmit(page, query, tag);
        if (ok && page.url().includes("/search")) return page;
      }
    } catch (e) {
      console.log(`${tag}[!] Aynı sekme arama başarısız: ${e.message.split("\n")[0]} — yeni sekme deneniyor`);
    }
  }

  // 2. Yeni sekme aç → Google.com → arama kutusuna yaz → submit
  try {
    const newPage = await browser.newPage();
    await newPage.goto(GOOGLE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomSleep(1, 2);

    const ok = await humanTypeAndSubmit(newPage, query, tag);
    if (ok && newPage.url().includes("/search")) return newPage;
  } catch (e) {
    console.log(`${tag}[!] Arama başarısız: ${e.message.split("\n")[0]}`);
  }

  // 3. Fallback: URL ile arama
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

async function searchAndClick(browser, query, adDomains, hitDomains, label = "", sessionAdClicks = {}, tracker = null, proxyApplied = null) {
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

  // Captcha tespit → captcha_action'a göre davran:
  //   "abort"          (default) → session terk
  //   "wait"           → provider'in (hyperbrowser/external) çözmesini bekle, max 60s
  //   "solve_continue" → mevcut CapSolver REST API ile çöz
  if (await isCaptchaPage(page)) {
    const action = config.behavior.captcha_action;

    if (action === "wait") {
      // Provider (hyperbrowser solveCaptchas) çözmesini bekle
      const waitSec = config.behavior.captcha_wait_seconds || 90;
      const iterations = Math.ceil(waitSec / 5);
      console.log(`${tag}⚠ Captcha algılandı — provider çözmesini bekliyoruz (max ${waitSec}s)...`);
      let resolved = false;
      for (let i = 0; i < iterations; i++) {
        await sleep(5000);
        if (!(await isCaptchaPage(page))) {
          console.log(`${tag}✓ Captcha provider tarafından çözüldü (${(i + 1) * 5}s)`);
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        console.log(`${tag}✗ Captcha ${waitSec}s'de çözülmedi → session terk`);
        return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "bot_detected" };
      }
      if (!page.url().includes("/search")) {
        const retryPage = await doSearch(browser, page, query, tag);
        if (retryPage) page = retryPage;
        else return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "search_failed" };
      }
      await randomSleep(1, 2);
    } else if (action === "solve_continue") {
      // CapSolver REST API ile çöz
      console.log(`${tag}⚠ Captcha algılandı — çözülmeye çalışılıyor (CapSolver)...`);
      const solved = await solveCaptcha(page, proxyApplied, tag);
      if (!solved) {
        return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "bot_detected" };
      }
      await randomSleep(2, 4);
      if (!page.url().includes("/search")) {
        console.log(`${tag}Captcha sonrası arama tekrarlanıyor...`);
        const retryPage = await doSearch(browser, page, query, tag);
        if (retryPage) page = retryPage;
        else return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "search_failed" };
      } else {
        console.log(`${tag}✓ Captcha çözüldü, arama sonuçlarında devam`);
      }
      if (await isCaptchaPage(page)) {
        console.log(`${tag}⚠ Captcha çözümü sonrası hala captcha — session atlanıyor`);
        return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "bot_detected" };
      }
    } else {
      // default: abort
      console.log(`${tag}⚠ Captcha algılandı (captcha_action=abort) → session terk`);
      return { ads: 0, hits: 0, totalAdsOnPage: 0, rankings: [], notFound: hitDomains, error: "bot_detected" };
    }
  }

  let totalAdsOnPage = 0;
  let adClicked = 0;
  let hitClicked = 0;
  const maxAdClicksPerDomain = config.behavior.max_clicks_per_domain_per_session || config.behavior.max_clicks_per_domain || (2 + Math.floor(Math.random() * 2));
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

    // Budget tracker'ı feed et (sadece ad domain'leri için)
    if (tracker && adDomains.length > 0) {
      tracker.update(allAdDomains, adDomains);
    }

    const searchAds = pg <= maxAdPages;
    const searchHits = pg <= maxHitPages && hitDomains.some((d) => !clickedHitDomains.has(d));

    const adDomainsList = allAdDomains.length > 0 ? ` [${allAdDomains.join(", ")}]` : "";
    console.log(`${tag}[Sayfa ${pg}] Toplam reklam: ${totalAds}${adDomainsList} | Hedef reklam: ${searchAds ? ads.length : "atlandı"} | Organik hit: ${searchHits ? organics.length : "atlandı"}`);

    // Reklamlara tıkla (yeni sekmede) - domain başına max 2-3
    if (searchAds) {
      for (const ad of ads) {
        // Tracker exhausted ise atla
        if (tracker && tracker.isExhausted(ad.domain)) {
          console.log(`${tag}⏭ ${ad.domain} exhausted (gün boyu atla)`);
          continue;
        }
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
            await takeScreenshot(page, ad.domain, tag, { query, page: pg });
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
          await takeScreenshot(page, hit.domain, tag, { query, page: pg, position: hit.position });
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
  // CDP üzerinden cookie + cache temizle (browser-wide)
  // localStorage/IndexedDB origin-bazlı, en bilindik Google origin'leri için temizle
  const pages = await browser.pages();
  if (pages.length === 0) return;
  const session = await pages[0].target().createCDPSession();
  try {
    // Browser-wide: cookies + cache
    await session.send("Network.clearBrowserCookies").catch(() => {});
    await session.send("Network.clearBrowserCache").catch(() => {});

    // Origin-bazlı: localStorage, sessionStorage, IndexedDB, service workers
    const origins = [
      "https://www.google.com",
      "https://google.com",
      "https://www.google.com.tr",
      "https://google.com.tr",
      "https://accounts.google.com",
      "https://www.youtube.com",
      "https://youtube.com",
    ];
    for (const origin of origins) {
      await session.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "all",
      }).catch(() => {});
    }
    console.log(`  ✓ Storage temizlendi (cookies + cache + ${origins.length} origin localStorage/IndexedDB)`);
  } catch (e) {
    console.log(`  ✗ Storage temizleme hatası: ${e.message.split("\n")[0]}`);
  }
  await session.detach().catch(() => {});
}

module.exports = { searchAndClick, closeExtraTabs, enableImageBlocking, clearGoogleCookies, clearAllGoogleCookies, sessionWarmup, clearAllStorage, doFillerSearches };
