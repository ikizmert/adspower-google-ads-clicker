const { config } = require("./config");

const API = config.adspower.api_url;

async function checkStatus() {
  const res = await fetch(`${API}/status`);
  const data = await res.json();
  return data.code === 0;
}

async function openBrowser(profileId) {
  const headless = config.behavior.headless ? 1 : 0;
  const url = `${API}/api/v1/browser/start?user_id=${profileId}&open_tabs=0&ip_tab=0&headless=${headless}`;

  // Rate limit retry (max 7 deneme, exponential backoff)
  let lastError;
  for (let attempt = 1; attempt <= 7; attempt++) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 0) {
      return {
        wsEndpoint: data.data.ws.puppeteer,
        driverPath: data.data.webdriver,
      };
    }
    lastError = data.msg;
    if (data.msg && data.msg.toLowerCase().includes("too many")) {
      const wait = 1000 * attempt; // 1s, 2s, 3s, 4s, 5s
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break; // Rate limit dışı hata, tekrar deneme
  }
  throw new Error(`AdsPower açılamadı: ${lastError}`);
}

async function closeBrowser(profileId) {
  const url = `${API}/api/v1/browser/stop?user_id=${profileId}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.code === 0;
}

async function listProfiles() {
  const url = `${API}/api/v1/user/list?page=1&page_size=100`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 0) return [];
  return data.data.list.map((p) => ({
    id: p.user_id,
    name: p.name,
    serial: p.serial_number,
    groupName: p.group_name,
  }));
}

async function getProfileInfo(profileId) {
  const url = `${API}/api/v1/user/list?user_id=${profileId}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 0 || !data.data.list.length) return null;
  const p = data.data.list[0];
  const groupName = (p.group_name || "").toLowerCase();
  const tags = (p.fbcc_user_tag || []).map((t) => t.name.toLowerCase());
  const name = (p.name || "").toLowerCase();
  const mobileKeywords = ["mobile", "android", "iphone", "ipad", "ios"];
  const isMobile = mobileKeywords.some((k) => groupName.includes(k) || name.includes(k) || tags.some((t) => t.includes(k)));
  return {
    id: p.user_id,
    name: p.name,
    serial: p.serial_number,
    groupName: p.group_name,
    isMobile,
  };
}

function randomSid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let sid = "";
  for (let i = 0; i < 8; i++) sid += chars[Math.floor(Math.random() * chars.length)];
  return sid;
}

async function applyStickyProxy(profileId) {
  const sid = randomSid();
  const proxyConfig = config.proxy;

  // Config'de proxy varsa direkt oradan al
  if (proxyConfig && proxyConfig.host) {
    const user = `${proxyConfig.base_user}_session-${sid}_life-30`;
    const updateUrl = `${API}/api/v1/user/update`;
    const updateRes = await fetch(updateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: profileId,
        user_proxy_config: {
          proxy_soft: "other",
          proxy_type: proxyConfig.type || "http",
          proxy_host: proxyConfig.host,
          proxy_port: proxyConfig.port,
          proxy_user: user,
          proxy_password: proxyConfig.password,
        },
      }),
    });
    const updateData = await updateRes.json();
    if (updateData.code === 0) {
      console.log(`  Sticky proxy: sid=${sid} (30dk)`);
    }
    return;
  }

  // Config'de proxy yoksa profildeki mevcut proxy'yi güncelle
  const infoUrl = `${API}/api/v1/user/list?user_id=${profileId}`;
  const infoRes = await fetch(infoUrl);
  const infoData = await infoRes.json();
  if (infoData.code !== 0 || !infoData.data.list.length) return;

  const proxy = infoData.data.list[0].user_proxy_config;
  if (!proxy || !proxy.proxy_user) return;

  let user = proxy.proxy_user;
  if (user.includes("_session-") || user.includes("ap-")) {
    user = user.replace(/_session-[^_]+/g, "").replace(/_life-\d+/g, "");
    user = `${user}_session-${sid}_life-30`;
  } else if (user.includes("-sid-") || user.includes("kte")) {
    user = user.replace(/-sid-[^-]+-t-\d+/g, "");
    user = `${user}-sid-${sid}-t-30`;
  } else {
    user = `${user}-sid-${sid}-t-30`;
  }

  const updateUrl = `${API}/api/v1/user/update`;
  const updateRes = await fetch(updateUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: profileId,
      user_proxy_config: { ...proxy, proxy_user: user },
    }),
  });
  const updateData = await updateRes.json();
  if (updateData.code === 0) {
    console.log(`  Sticky proxy: sid=${sid} (30dk)`);
  }
}

async function clearCache(profileId) {
  const url = `${API}/api/v1/user/delete-cache`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: profileId }),
  });
  const data = await res.json();
  return data.code === 0;
}

module.exports = { checkStatus, openBrowser, closeBrowser, listProfiles, getProfileInfo, clearCache, applyStickyProxy };
