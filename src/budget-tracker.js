const fs = require("fs");
const path = require("path");

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return null;
  }
}

function saveState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch {}
}

function createTracker({ stateFile, threshold = 3 }) {
  let state = loadState(stateFile);

  // Date değişimi → state sıfırla
  if (!state || state.date !== todayStr()) {
    state = { date: todayStr(), domains: {} };
    saveState(stateFile, state);
  }

  function ensureDomain(domain) {
    if (!state.domains[domain]) {
      state.domains[domain] = { exhausted: false, missed: 0, lastSeenAt: 0 };
    }
    return state.domains[domain];
  }

  function update(allAdDomains, targetDomains) {
    // Sayfada hiç reklam yoksa hiçbir sinyal yok — miss sayma
    // ("rakip exhausted" anlamak için sayfada en az bir reklam görmek lazım)
    if (allAdDomains.length === 0) return;

    const seenSet = new Set();
    for (const ad of allAdDomains) {
      seenSet.add(ad.toLowerCase());
    }
    const now = Date.now();
    for (const target of targetDomains) {
      const t = target.toLowerCase();
      const d = ensureDomain(t);

      // Substring match (target "denizcicekci" sayfada "denizcicekcilik.com" varsa eşleş)
      const seen = [...seenSet].some((s) => s.includes(t));
      if (seen) {
        d.missed = 0;
        d.lastSeenAt = now;
        d.exhausted = false;  // re-appearing target un-exhausts itself
      } else if (!d.exhausted) {
        // exhausted domains: don't increment miss further, but un-exhaust above if they reappear
        d.missed += 1;
        if (d.missed >= threshold) d.exhausted = true;
      }
    }
    saveState(stateFile, state);
  }

  function isExhausted(domain) {
    const d = state.domains[domain.toLowerCase()];
    return d ? d.exhausted : false;
  }

  function getMissed(domain) {
    const d = state.domains[domain.toLowerCase()];
    return d ? d.missed : 0;
  }

  function allTargetsExhausted(targetDomains) {
    if (targetDomains.length === 0) return false;
    return targetDomains.every((t) => isExhausted(t));
  }

  function getState() {
    return state;
  }

  return { update, isExhausted, getMissed, allTargetsExhausted, getState };
}

module.exports = { createTracker };
