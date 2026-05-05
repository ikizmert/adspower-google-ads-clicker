const { config } = require("./config");

const API = config.adspower.api_url;

async function checkStatus() {
  const res = await fetch(`${API}/status`);
  const data = await res.json();
  return data.code === 0;
}

async function openBrowser(profileId) {
  const url = `${API}/api/v1/browser/start?user_id=${profileId}&open_tabs=0&ip_tab=0`;
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
  }));
}

module.exports = { checkStatus, openBrowser, closeBrowser, listProfiles };
