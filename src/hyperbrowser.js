const Hyperbrowser = require("@hyperbrowser/sdk").default || require("@hyperbrowser/sdk").Hyperbrowser;
const { config } = require("./config");

const API_KEY = config.hyperbrowser && config.hyperbrowser.api_key;
let client = null;

function getClient() {
  if (!client) {
    if (!API_KEY) throw new Error("config.hyperbrowser.api_key eksik!");
    client = new Hyperbrowser({ apiKey: API_KEY });
  }
  return client;
}

// Aktif session'ları tut (profileId → sessionId mapping)
const activeSessions = new Map();

async function checkStatus() {
  return !!API_KEY;
}

function randomSid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function openBrowser(profileId) {
  const hb = getClient();
  const hbConfig = config.hyperbrowser || {};
  // Docs: "Pair stealth with proxies for better results". Default açık.
  const sessionOpts = {
    solveCaptchas: hbConfig.solve_captchas === true,
    useStealth: hbConfig.use_stealth !== false,
    adblock: false,
  };

  // Proxy seçimi — 3 mod:
  //   1. use_managed_proxy: true → hyperbrowser yönetilen TR proxy (farklı havuz, aproxy flag yediyse alternatif)
  //   2. config.proxy.host varsa → BYO external (aproxy)
  //   3. Hiçbiri → proxy yok (free plan'da olabilir)
  if (hbConfig.use_managed_proxy === true) {
    sessionOpts.useProxy = true;
    sessionOpts.proxyCountry = hbConfig.proxy_country || "TR";
    if (hbConfig.proxy_city) sessionOpts.proxyCity = hbConfig.proxy_city;
    console.log(`  Sticky proxy (hyperbrowser managed): country=${sessionOpts.proxyCountry}${hbConfig.proxy_city ? " city=" + hbConfig.proxy_city : ""}`);
  } else if (config.proxy && config.proxy.host) {
    const sid = randomSid();
    const scheme = config.proxy.type || "http";
    sessionOpts.useProxy = true;
    sessionOpts.proxyServer = `${scheme}://${config.proxy.host}:${config.proxy.port}`;
    sessionOpts.proxyServerUsername = `${config.proxy.base_user}_session-${sid}`;
    sessionOpts.proxyServerPassword = config.proxy.password;
    console.log(`  Sticky proxy (BYO external): sid=${sid}`);
  } else {
    sessionOpts.useProxy = hbConfig.use_proxy === true;
  }

  const session = await hb.sessions.create(sessionOpts);
  activeSessions.set(profileId, session.id);

  return {
    wsEndpoint: session.wsEndpoint,
    sessionId: session.id,
  };
}

async function closeBrowser(profileId) {
  const hb = getClient();
  const sessionId = activeSessions.get(profileId);
  if (sessionId) {
    try {
      await hb.sessions.stop(sessionId);
    } catch {}
    activeSessions.delete(profileId);
  }
  return true;
}

// Hyperbrowser'da profil yok — sanal profil listesi (config'den browser_count kadar)
async function listProfiles() {
  const count = (config.behavior && config.behavior.browser_count) || 5;
  const profiles = [];
  for (let i = 1; i <= count * 2; i++) {
    profiles.push({
      id: `hb-${i}`,
      name: `HB-${i}`,
      serial: String(i),
      groupName: "Hyperbrowser",
    });
  }
  return profiles;
}

async function getProfileInfo(profileId) {
  return {
    id: profileId,
    name: profileId,
    serial: profileId.replace("hb-", ""),
    groupName: "Hyperbrowser",
    isMobile: false,
  };
}

async function clearCache(profileId) {
  // Hyperbrowser'da her session zaten temiz başlar
  return true;
}

async function applyStickyProxy(profileId) {
  // Hyperbrowser'da proxy session'da ayarlanıyor (openBrowser'da)
  return true;
}

module.exports = { checkStatus, openBrowser, closeBrowser, listProfiles, getProfileInfo, clearCache, applyStickyProxy };
