const { config } = require("./config");
const { selectProvider, selectCity, composeProxyUser } = require("./proxy-rotation");

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

async function applyStickyProxy(profileId, overrideSid = null) {
  const sid = overrideSid || randomSid();
  let appliedUser = "";
  const rotation = config.proxy_rotation;

  // Yeni schema: proxy_rotation.providers
  if (rotation && rotation.enabled && Array.isArray(rotation.providers) && rotation.providers.length > 0) {
    const provider = selectProvider(rotation.providers);
    const city = selectCity(provider);
    const user = composeProxyUser(provider, city, sid);
    appliedUser = user;

    const updateUrl = `${API}/api/v1/user/update`;
    const updateRes = await fetch(updateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: profileId,
        user_proxy_config: {
          proxy_soft: "other",
          proxy_type: provider.type || "http",
          proxy_host: provider.host,
          proxy_port: provider.port,
          proxy_user: user,
          proxy_password: provider.password,
        },
      }),
    });
    const updateData = await updateRes.json();
    if (updateData.code === 0) {
      console.log(`  Sticky proxy: ${provider.name} ${city || "TR"} sid=${sid}`);
    }
    return { sid, proxyUser: appliedUser, provider };
  }

  // Eski schema fallback (config.proxy.host varsa)
  const proxyConfig = config.proxy;
  if (proxyConfig && proxyConfig.host) {
    const user = `${proxyConfig.base_user}_session-${sid}`;
    appliedUser = user;
    const updateUrl = `${API}/api/v1/user/update`;
    await fetch(updateUrl, {
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
    const lifeMatch = (proxyConfig.base_user || "").match(/life-(\d+)/);
    const lifeInfo = lifeMatch ? `${lifeMatch[1]}dk` : "default";
    console.log(`  Sticky proxy (legacy): sid=${sid} (life=${lifeInfo})`);
    return { sid, proxyUser: appliedUser, provider: null };
  }
  return { sid: null, proxyUser: "", provider: null };
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
