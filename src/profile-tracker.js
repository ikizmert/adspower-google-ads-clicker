const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "profiles.json");

function load() {
  if (!fs.existsSync(DATA_PATH)) return {};
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
}

function save(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function getProfile(profileId) {
  const data = load();
  if (!data[profileId]) {
    data[profileId] = { sessions: 0, no_ads_streak: 0 };
    save(data);
  }
  return data[profileId];
}

function recordSession(profileId, totalAdsFound) {
  const data = load();
  if (!data[profileId]) {
    data[profileId] = { sessions: 0, no_ads_streak: 0 };
  }
  data[profileId].sessions++;
  if (totalAdsFound === 0) {
    data[profileId].no_ads_streak++;
  } else {
    data[profileId].no_ads_streak = 0;
  }
  save(data);
  return data[profileId];
}

function shouldReset(profileId) {
  const p = getProfile(profileId);
  if (p.sessions >= 5) return "max_sessions";
  if (p.no_ads_streak >= 3) return "no_ads";
  return null;
}

function removeProfile(profileId) {
  const data = load();
  delete data[profileId];
  save(data);
}

function pickBestProfile(profileIds) {
  const data = load();
  let best = null;
  let minSessions = Infinity;
  for (const id of profileIds) {
    const sessions = (data[id] && data[id].sessions) || 0;
    if (sessions < minSessions) {
      minSessions = sessions;
      best = id;
    }
  }
  return best;
}

module.exports = { getProfile, recordSession, shouldReset, removeProfile, pickBestProfile };
