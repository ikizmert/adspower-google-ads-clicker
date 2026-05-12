const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createProfileStateManager } = require("./profile-state");

function tmpFile() {
  return path.join(os.tmpdir(), `profile-state-test-${Date.now()}-${Math.random()}.json`);
}

test("yeni profil cold state'inde başlar", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  assert.equal(mgr.getState("p1").state, "cold");
  // getState alone doesn't write to disk (pure ensure); file may not exist
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test("transition cold → warming → warm geçişi", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  mgr.transition("p1", "warming");
  assert.equal(mgr.getState("p1").state, "warming");
  mgr.transition("p1", "warm");
  assert.equal(mgr.getState("p1").state, "warm");
  assert.equal(mgr.getState("p1").warmupCount, 1);
  fs.unlinkSync(file);
});

test("click sonrası cooling + cooldownUntil set edilir (success)", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  mgr.transition("p1", "warming");
  mgr.transition("p1", "warm");
  mgr.transition("p1", "clicking");
  const before = Date.now();
  mgr.transition("p1", "cooling", { failure: false });
  const s = mgr.getState("p1");
  assert.equal(s.state, "cooling");
  assert.equal(s.clickCount, 1);
  assert.ok(s.cooldownUntil >= before + 1000 - 50, "successCooldown uygulanmalı");
  fs.unlinkSync(file);
});

test("failure transition → failureCooldown uygulanır", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 5000 });
  mgr.transition("p1", "warming");
  const before = Date.now();
  mgr.transition("p1", "cold", { failure: true });
  const s = mgr.getState("p1");
  assert.equal(s.state, "cold");
  assert.ok(s.cooldownUntil >= before + 5000 - 50, "failureCooldown uygulanmalı");
  fs.unlinkSync(file);
});

test("geçersiz state'e transition reddedilir + side effect yok", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  assert.throws(() => mgr.transition("p1", "frozen"), /invalid state/i);
  // Spec: invalid state'e transition side-effect oluşturmamalı — disk'e p1 yazılmamış olmalı
  assert.equal(fs.existsSync(file), false, "invalid transition diske yazmamalı");
});

test("cooldown geçince cooling → cold otomatik geçer", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 50, failureCooldownMs: 100 });
  mgr.transition("p1", "warming");
  mgr.transition("p1", "warm");
  mgr.transition("p1", "clicking");
  mgr.transition("p1", "cooling", { failure: false });
  return new Promise((resolve) => {
    setTimeout(() => {
      mgr.tick();
      assert.equal(mgr.getState("p1").state, "cold");
      fs.unlinkSync(file);
      resolve();
    }, 100);
  });
});

test("selectNextTask: warm + pending → click", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  mgr.transition("p1", "warming");
  mgr.transition("p1", "warm");
  const decision = mgr.selectNextTask(["p1", "p2"], true);
  assert.equal(decision.type, "click");
  assert.equal(decision.profileId, "p1");
  fs.unlinkSync(file);
});

test("selectNextTask: warm yok ama cold var → warmup", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  const decision = mgr.selectNextTask(["p1", "p2"], true);
  assert.equal(decision.type, "warmup");
  assert.ok(["p1", "p2"].includes(decision.profileId));
  // selectNextTask with no prior transition doesn't write to disk (pure ensure)
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test("selectNextTask: warm var ama pending target yok → null (pool boşa beslenmez)", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  mgr.transition("p1", "warming");
  mgr.transition("p1", "warm");
  const decision = mgr.selectNextTask(["p1", "p2"], false);
  assert.equal(decision, null);
  fs.unlinkSync(file);
});

test("selectNextTask: tüm profiller cooldown'da → null", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 60000, failureCooldownMs: 60000 });
  mgr.transition("p1", "cold", { failure: true });
  mgr.transition("p2", "cold", { failure: true });
  const decision = mgr.selectNextTask(["p1", "p2"], true);
  assert.equal(decision, null);
  fs.unlinkSync(file);
});

test("selectNextTask: busy state'ler skip edilir (warming, clicking)", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  mgr.transition("p1", "warming");
  mgr.transition("p2", "warming");
  mgr.transition("p2", "warm");
  mgr.transition("p2", "clicking");
  const decision = mgr.selectNextTask(["p1", "p2", "p3"], true);
  assert.equal(decision.type, "warmup");
  assert.equal(decision.profileId, "p3");
  fs.unlinkSync(file);
});
