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
        const enterprise = src.includes("/enterprise/");
        // anchor ve reload iframe URL'lerini topla (enterprise task için gerekli)
        const anchorIframe = document.querySelector(
          enterprise
            ? 'iframe[src*="/enterprise/anchor"]'
            : 'iframe[src*="/api2/anchor"]'
        );
        const reloadIframe = document.querySelector(
          enterprise
            ? 'iframe[src*="/enterprise/reload"]'
            : 'iframe[src*="/api2/reload"]'
        );
        return {
          sitekey: decodeURIComponent(m[1]),
          enterprise,
          websiteURL: location.href,
          anchor: anchorIframe ? anchorIframe.src : src,
          reload: reloadIframe ? reloadIframe.src : undefined,
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
  // Proxy ile çöz — aynı IP'den token üretilsin (IP mismatch önle)
  const task = {
    type: "ReCaptchaV2Task",
    websiteURL: info.websiteURL,
    websiteKey: info.sitekey,
    proxyType: (proxy.type || "http").toLowerCase(),
    proxyAddress: proxy.host,
    proxyPort: parseInt(proxy.port, 10),
    proxyLogin: proxy.login,
    proxyPassword: proxy.password,
  };
  if (info.anchor) task.anchor = info.anchor;
  if (info.reload) task.reload = info.reload;
  const body = { clientKey: config.capsolver_api_key, task };

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

async function injectAndSubmit(page, token, tag = "") {
  // Fetch ile form submit — browser cookie'leri dahil, redirect URL'ini yakala
  const result = await page.evaluate(async (tok) => {
    try {
      const form = document.getElementById('captcha-form') || document.querySelector('form');
      if (!form) return { ok: false, reason: "no-form" };

      const formData = new FormData(form);
      formData.set('g-recaptcha-response', tok);

      const res = await fetch('https://www.google.com/sorry/index', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      return { ok: true, url: res.url, status: res.status };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }, token).catch((e) => ({ ok: false, reason: e.message }));

  console.log(`${tag}📋 Fetch result: ${JSON.stringify(result)}`);

  if (result && result.ok && result.url && !result.url.includes('/sorry')) {
    // Token kabul edildi — browser'ı redirect URL'ine yönlendir
    await page.goto(result.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  } else {
    // Fallback: form.submit() ile dene
    await page.evaluate((tok) => {
      const form = document.getElementById('captcha-form') || document.querySelector('form');
      if (!form) return;
      let f = form.querySelector('textarea[name="g-recaptcha-response"]');
      if (!f) {
        f = document.createElement('textarea');
        f.name = 'g-recaptcha-response';
        f.style.display = 'none';
        form.appendChild(f);
      }
      f.value = tok;
      form.submit();
    }, token).catch(() => {});
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  }
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
    console.log(`${tag}🔑 Sitekey: ${info.sitekey.substring(0, 30)}... (enterprise=${info.enterprise}, anchor=${info.anchor ? "var" : "yok"})`);

    console.log(`${tag}📤 CapSolver task gönderiliyor (Proxy, enterprise=${info.enterprise})...`);
    const taskId = await createTask(info, proxy, tag);
    console.log(`${tag}🆔 TaskID: ${taskId}`);

    console.log(`${tag}⏳ Çözüm bekleniyor (max 120s)...`);
    const token = await pollResult(taskId);
    console.log(`${tag}🎫 Token alındı (${token.length} karakter)`);

    await injectAndSubmit(page, token, tag);
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
