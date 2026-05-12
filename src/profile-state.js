const fs = require("fs");

const VALID_STATES = ["cold", "warming", "warm", "clicking", "cooling"];

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return { profiles: {} };
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return { profiles: {} };
  }
}

function createProfileStateManager({ stateFile, successCooldownMs, failureCooldownMs }) {
  let data = loadState(stateFile);
  if (!data.profiles) data.profiles = {};

  function ensure(profileId) {
    if (!data.profiles[profileId]) {
      data.profiles[profileId] = {
        state: "cold",
        lastTransitionAt: Date.now(),
        cooldownUntil: 0,
        warmupCount: 0,
        clickCount: 0,
        currentSid: null,
        transientFails: 0,
      };
    }
    return data.profiles[profileId];
  }

  function getState(profileId) {
    return { ...ensure(profileId) };
  }

  function transition(profileId, newState, opts = {}) {
    if (!VALID_STATES.includes(newState)) {
      throw new Error(`invalid state: ${newState}`);
    }
    const p = ensure(profileId);
    const prev = p.state;
    p.state = newState;
    p.lastTransitionAt = Date.now();

    if (prev === "warming" && newState === "warm") p.warmupCount += 1;
    if (prev === "clicking" && newState === "cooling") p.clickCount += 1;

    if (newState === "cooling") {
      p.cooldownUntil = Date.now() + (opts.failure ? failureCooldownMs : successCooldownMs);
    }
    if (newState === "cold" && opts.failure) {
      p.cooldownUntil = Date.now() + failureCooldownMs;
    }

    atomicWrite(stateFile, data);
  }

  function tick() {
    const now = Date.now();
    let dirty = false;
    for (const id of Object.keys(data.profiles)) {
      const p = data.profiles[id];
      if (p.state === "cooling" && now >= p.cooldownUntil) {
        p.state = "cold";
        p.lastTransitionAt = now;
        dirty = true;
      }
    }
    if (dirty) atomicWrite(stateFile, data);
  }

  function isAvailable(profileId) {
    const p = ensure(profileId);
    const now = Date.now();
    if (p.state === "warming" || p.state === "clicking") return false;
    if (p.cooldownUntil && now < p.cooldownUntil) return false;
    return true;
  }

  function selectNextTask(profileIds, hasPendingTargets, allowedTypes = ["click", "warmup"]) {
    tick();
    if (!hasPendingTargets) return null;
    if (allowedTypes.includes("click")) {
      const warmProfile = profileIds.find((id) => ensure(id).state === "warm" && isAvailable(id));
      if (warmProfile) {
        return { type: "click", profileId: warmProfile };
      }
    }
    if (allowedTypes.includes("warmup")) {
      const coldProfile = profileIds.find((id) => ensure(id).state === "cold" && isAvailable(id));
      if (coldProfile) {
        return { type: "warmup", profileId: coldProfile };
      }
    }
    return null;
  }

  function setSid(profileId, sid) {
    const p = ensure(profileId);
    p.currentSid = sid;
    atomicWrite(stateFile, data);
  }

  function getSid(profileId) {
    return ensure(profileId).currentSid;
  }

  function incrementTransientFails(profileId) {
    const p = ensure(profileId);
    p.transientFails = (p.transientFails || 0) + 1;
    atomicWrite(stateFile, data);
    return p.transientFails;
  }

  function resetTransientFails(profileId) {
    const p = ensure(profileId);
    if (p.transientFails > 0) {
      p.transientFails = 0;
      atomicWrite(stateFile, data);
    }
  }

  function getTransientFails(profileId) {
    return ensure(profileId).transientFails || 0;
  }

  function setCustomCooldown(profileId, ms) {
    const p = ensure(profileId);
    p.state = "cooling";
    p.lastTransitionAt = Date.now();
    p.cooldownUntil = Date.now() + ms;
    atomicWrite(stateFile, data);
  }

  function save() {
    atomicWrite(stateFile, data);
  }

  function resetStaleBusyStates() {
    // Process crash/Ctrl+C sonrası warming/clicking state'inde takılı profilleri cold'a reset et.
    // Bunlar gerçek aktif task değil — eski process'ten kalma.
    let count = 0;
    for (const id of Object.keys(data.profiles)) {
      const p = data.profiles[id];
      if (p.state === "warming" || p.state === "clicking") {
        p.state = "cold";
        p.lastTransitionAt = Date.now();
        p.cooldownUntil = 0;  // immediate availability — they didn't actually fail
        count += 1;
      }
    }
    if (count > 0) {
      atomicWrite(stateFile, data);
    }
    return count;
  }

  return { getState, save, transition, tick, selectNextTask, isAvailable, getSid, setSid, resetStaleBusyStates, incrementTransientFails, resetTransientFails, getTransientFails, setCustomCooldown };
}

module.exports = { createProfileStateManager, VALID_STATES };
