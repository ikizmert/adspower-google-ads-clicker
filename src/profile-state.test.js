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

test("selectNextTask: allowedTypes=['click'] → warm profil yoksa null (warmup'a düşmez)", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  // p1, p2 cold (default)
  const decision = mgr.selectNextTask(["p1", "p2"], true, ["click"]);
  assert.equal(decision, null);
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

test("selectNextTask: allowedTypes=['warmup'] → warm profil olsa bile warmup seçer", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  mgr.transition("p1", "warming");
  mgr.transition("p1", "warm");
  // p2, p3 cold
  const decision = mgr.selectNextTask(["p1", "p2", "p3"], true, ["warmup"]);
  assert.equal(decision.type, "warmup");
  assert.ok(["p2", "p3"].includes(decision.profileId));
  fs.unlinkSync(file);
});

test("setSid + getSid: sid persist eder", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  assert.equal(mgr.getSid("p1"), null);
  mgr.setSid("p1", "ABCD1234");
  assert.equal(mgr.getSid("p1"), "ABCD1234");
  fs.unlinkSync(file);
});

test("setSid: yeni sid eski sid'i overwrite eder", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  mgr.setSid("p1", "FIRST");
  mgr.setSid("p1", "SECOND");
  assert.equal(mgr.getSid("p1"), "SECOND");
  fs.unlinkSync(file);
});

test("resetStaleBusyStates: warming/clicking → cold reset edilir (process crash recovery)", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  mgr.transition("p1", "warming");
  mgr.transition("p2", "warming");
  mgr.transition("p2", "warm");
  mgr.transition("p2", "clicking");
  mgr.transition("p3", "warming");
  mgr.transition("p3", "warm");
  // Şu an: p1=warming, p2=clicking, p3=warm
  const resetCount = mgr.resetStaleBusyStates();
  assert.equal(resetCount, 2);
  assert.equal(mgr.getState("p1").state, "cold");
  assert.equal(mgr.getState("p2").state, "cold");
  assert.equal(mgr.getState("p3").state, "warm");  // warm dokunulmaz
  fs.unlinkSync(file);
});

test("resetStaleBusyStates: reset edilen profil cooldown'a girmez (failure değil)", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 5000, failureCooldownMs: 10000 });
  mgr.transition("p1", "warming");
  mgr.resetStaleBusyStates();
  assert.equal(mgr.getState("p1").cooldownUntil, 0);  // hemen kullanılabilir
  assert.equal(mgr.isAvailable("p1"), true);
  fs.unlinkSync(file);
});

test("transientFails: increment/reset/get çalışır", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  assert.equal(mgr.getTransientFails("p1"), 0);
  assert.equal(mgr.incrementTransientFails("p1"), 1);
  assert.equal(mgr.incrementTransientFails("p1"), 2);
  assert.equal(mgr.getTransientFails("p1"), 2);
  mgr.resetTransientFails("p1");
  assert.equal(mgr.getTransientFails("p1"), 0);
  fs.unlinkSync(file);
});

test("transientFails: yeni profil için 0 default", () => {
  const file = tmpFile();
  const mgr = createProfileStateManager({ stateFile: file, successCooldownMs: 1000, failureCooldownMs: 2000 });
  assert.equal(mgr.getTransientFails("newprofile"), 0);
  if (fs.existsSync(file)) fs.unlinkSync(file);
});
