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
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`AdsPower açılamadı: ${data.msg}`);
  }
  return {
    wsEndpoint: data.data.ws.puppeteer,
    driverPath: data.data.webdriver,
  };
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

module.exports = { checkStatus, openBrowser, closeBrowser, listProfiles, getProfileInfo, clearCache };
