const fs = require("fs");
const path = require("path");

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
      };
      atomicWrite(stateFile, data);
    }
    return data.profiles[profileId];
  }

  function getState(profileId) {
    return ensure(profileId);
  }

  function transition(profileId, newState, opts = {}) {
    const p = ensure(profileId);
    if (!VALID_STATES.includes(newState)) {
      throw new Error(`invalid state: ${newState}`);
    }
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

  function selectNextTask(profileIds, hasPendingTargets) {
    tick();
    const warmProfile = profileIds.find((id) => ensure(id).state === "warm" && isAvailable(id));
    if (warmProfile && hasPendingTargets) {
      return { type: "click", profileId: warmProfile };
    }
    if (!hasPendingTargets) return null;
    const coldProfile = profileIds.find((id) => ensure(id).state === "cold" && isAvailable(id));
    if (coldProfile) {
      return { type: "warmup", profileId: coldProfile };
    }
    return null;
  }

  function save() {
    atomicWrite(stateFile, data);
  }

  return { getState, save, transition, tick, selectNextTask, isAvailable };
}

module.exports = { createProfileStateManager, VALID_STATES };
