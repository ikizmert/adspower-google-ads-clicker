const { config } = require("./config");

const CAPSOLVER_API = "https://api.capsolver.com";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function detectCaptchaInfo(page) {
  return await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe[src*="recaptcha"]'));
    for (const iframe of iframes) {
      const src = iframe.src || "";
      const m = src.match(/[?&]k=([^&]+)/);
      if (m) {
        return {
          sitekey: decodeURIComponent(m[1]),
          enterprise: src.includes("/enterprise/"),
          websiteURL: location.href,
        };
      }
    }
    const elem = document.querySelector("[data-sitekey]");
    if (elem) {
      return {
        sitekey: elem.getAttribute("data-sitekey"),
        enterprise: false,
        websiteURL: location.href,
      };
    }
    return null;
  }).catch(() => null);
}

async function createTask(info, proxy, tag = "") {
  const taskType = info.enterprise ? "ReCaptchaV2EnterpriseTask" : "ReCaptchaV2Task";
  const body = {
    clientKey: config.capsolver_api_key,
    task: {
      type: taskType,
      websiteURL: info.websiteURL,
      websiteKey: info.sitekey,
      proxyType: (proxy.type || "http").toLowerCase(),
      proxyAddress: proxy.host,
      proxyPort: parseInt(proxy.port, 10),
      proxyLogin: proxy.login,
      proxyPassword: proxy.password,
    },
  };

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.errorId) return data.taskId;

    const errMsg = `${data.errorCode || ""} ${data.errorDescription || ""}`.trim();
    const isRetryable = errMsg.includes("PROXY_CONNECT") || errMsg.includes("PROXY_TIMEOUT") || errMsg.includes("ERROR_PROXY");
    if (!isRetryable || attempt === MAX_RETRIES) {
      throw new Error(`createTask: ${errMsg}`);
    }
    const wait = attempt * 3000;
    console.log(`${tag}⚠ createTask proxy hatası (${attempt}/${MAX_RETRIES}), ${wait / 1000}s sonra tekrar: ${errMsg}`);
    await sleep(wait);
  }
}

async function pollResult(taskId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(3000);
    const res = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: config.capsolver_api_key, taskId }),
    });
    const data = await res.json();
    if (data.errorId) {
      throw new Error(`getTaskResult: ${data.errorCode || ""} ${data.errorDescription || ""}`.trim());
    }
    if (data.status === "ready") {
      return data.solution.gRecaptchaResponse;
    }
  }
  throw new Error("CapSolver timeout");
}

async function injectAndSubmit(page, token) {
  await page.evaluate((tok) => {
    document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach((t) => {
      t.value = tok;
      t.style.display = "block";
      t.dispatchEvent(new Event("change", { bubbles: true }));
    });
    if (typeof window.grecaptchaCallback === "function") {
      try { window.grecaptchaCallback(tok); } catch {}
    }
  }, token).catch(() => {});

  await sleep(500);

  // Submit button — Google /sorry sayfasında genelde "Continue" butonu
  const submitClicked = await page.evaluate(() => {
    const candidates = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button#submit',
      'form button',
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); return true; }
    }
    return false;
  }).catch(() => false);

  if (!submitClicked) {
    // Fallback: form submit
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (form) form.submit();
    }).catch(() => {});
  }

  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
}

async function solveCaptcha(page, proxyApplied, tag = "") {
  if (!config.capsolver_api_key) {
    console.log(`${tag}✗ CapSolver API key yok`);
    return false;
  }
  if (!proxyApplied || !proxyApplied.proxyUser) {
    console.log(`${tag}✗ Proxy bilgisi yok — captcha API'ye gönderilemez`);
    return false;
  }

  const proxyConfig = config.proxy || {};
  const proxy = {
    type: proxyConfig.type || "http",
    host: proxyConfig.host,
    port: proxyConfig.port,
    login: proxyApplied.proxyUser,
    password: proxyConfig.password,
  };

  try {
    console.log(`${tag}🔎 Captcha sitekey aranıyor...`);
    const info = await detectCaptchaInfo(page);
    if (!info || !info.sitekey) {
      console.log(`${tag}✗ Sitekey bulunamadı`);
      return false;
    }
    console.log(`${tag}🔑 Sitekey: ${info.sitekey.substring(0, 30)}... (enterprise=${info.enterprise})`);

    console.log(`${tag}📤 CapSolver task gönderiliyor (proxy=${proxy.host}:${proxy.port})...`);
    const taskId = await createTask(info, proxy, tag);
    console.log(`${tag}🆔 TaskID: ${taskId}`);

    console.log(`${tag}⏳ Çözüm bekleniyor (max 120s)...`);
    const token = await pollResult(taskId);
    console.log(`${tag}🎫 Token alındı (${token.length} karakter)`);

    await injectAndSubmit(page, token);
    await sleep(2000);

    const url = page.url();
    if (!url.includes("/sorry") && !url.includes("captcha")) {
      console.log(`${tag}✓ Captcha çözüldü → ${url.substring(0, 80)}`);
      return true;
    }
    console.log(`${tag}✗ Token submit edildi ama hala captcha sayfasında: ${url.substring(0, 80)}`);
    return false;
  } catch (e) {
    console.log(`${tag}✗ CapSolver hatası: ${e.message.split("\n")[0]}`);
    return false;
  }
}

module.exports = { solveCaptcha };
