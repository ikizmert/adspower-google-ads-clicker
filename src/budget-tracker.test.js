const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Tracker ayrı tmpdir'de test edilir, gerçek dosyaya dokunmaz
function makeTmpTracker() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
  const stateFile = path.join(tmpDir, "budget-state.json");
  const { createTracker } = require("./budget-tracker");
  return { tracker: createTracker({ stateFile, threshold: 3 }), tmpDir, stateFile };
}

test("yeni tracker — state boş, hiçbir domain exhausted değil", () => {
  const { tracker } = makeTmpTracker();
  assert.strictEqual(tracker.isExhausted("foo.com"), false);
  assert.strictEqual(tracker.allTargetsExhausted(["foo.com", "bar.com"]), false);
});

test("update: target görünüyorsa miss=0", () => {
  const { tracker } = makeTmpTracker();
  tracker.update(["foo.com", "other.com"], ["foo.com"]);
  assert.strictEqual(tracker.getMissed("foo.com"), 0);
  assert.strictEqual(tracker.isExhausted("foo.com"), false);
});

test("update: target görünmüyorsa miss++", () => {
  const { tracker } = makeTmpTracker();
  tracker.update(["other.com"], ["foo.com"]);
  assert.strictEqual(tracker.getMissed("foo.com"), 1);
});

test("threshold'a ulaşınca exhausted=true", () => {
  const { tracker } = makeTmpTracker();
  tracker.update(["other.com"], ["foo.com"]); // miss=1
  tracker.update(["other.com"], ["foo.com"]); // miss=2
  tracker.update(["other.com"], ["foo.com"]); // miss=3 → exhausted
  assert.strictEqual(tracker.isExhausted("foo.com"), true);
});

test("exhausted domain miss artmaya devam etmez (idempotent)", () => {
  const { tracker } = makeTmpTracker();
  for (let i = 0; i < 5; i++) tracker.update(["other.com"], ["foo.com"]);
  assert.strictEqual(tracker.isExhausted("foo.com"), true);
  // Exhausted domain görünmemeye devam ederse miss daha da artmaz (idempotent)
  // Not: artık exhausted sticky değil — domain tekrar görünürse un-exhausts
  tracker.update(["other.com"], ["foo.com"]);
  assert.strictEqual(tracker.isExhausted("foo.com"), true); // hala exhausted (görünmedi)
});

test("görünen domain miss reset", () => {
  const { tracker } = makeTmpTracker();
  tracker.update(["other.com"], ["foo.com"]); // miss=1
  tracker.update(["other.com"], ["foo.com"]); // miss=2
  tracker.update(["foo.com"], ["foo.com"]);   // görünü → miss=0
  assert.strictEqual(tracker.getMissed("foo.com"), 0);
  assert.strictEqual(tracker.isExhausted("foo.com"), false);
});

test("allTargetsExhausted — hepsi exhausted ise true", () => {
  const { tracker } = makeTmpTracker();
  // Boş sayfa sinyal vermez; başka reklamcı varken target görünmüyorsa exhausted olur
  for (let i = 0; i < 3; i++) tracker.update(["other.com"], ["a.com", "b.com"]);
  assert.strictEqual(tracker.allTargetsExhausted(["a.com", "b.com"]), true);
});

test("allTargetsExhausted — biri exhausted değilse false", () => {
  const { tracker } = makeTmpTracker();
  for (let i = 0; i < 3; i++) tracker.update(["b.com"], ["a.com", "b.com"]);
  assert.strictEqual(tracker.isExhausted("a.com"), true);
  assert.strictEqual(tracker.isExhausted("b.com"), false);
  assert.strictEqual(tracker.allTargetsExhausted(["a.com", "b.com"]), false);
});

test("disk persist — state restart sonrası okunabilir", () => {
  const { tracker, stateFile } = makeTmpTracker();
  tracker.update(["other.com"], ["foo.com"]); // miss=1
  tracker.update(["other.com"], ["foo.com"]); // miss=2
  // Aynı dosyadan yeni tracker
  delete require.cache[require.resolve("./budget-tracker")];
  const { createTracker } = require("./budget-tracker");
  const t2 = createTracker({ stateFile, threshold: 3 });
  assert.strictEqual(t2.getMissed("foo.com"), 2);
});

test("date değişimi — state otomatik sıfırlanır", () => {
  const { stateFile } = makeTmpTracker();
  // Manuel olarak dünün state'ini yaz
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  fs.writeFileSync(stateFile, JSON.stringify({
    date: yesterday,
    domains: { "old.com": { exhausted: true, missed: 3, lastSeenAt: 0 } }
  }));
  delete require.cache[require.resolve("./budget-tracker")];
  const { createTracker } = require("./budget-tracker");
  const tracker = createTracker({ stateFile, threshold: 3 });
  // Eski state silindi, exhausted değil
  assert.strictEqual(tracker.isExhausted("old.com"), false);
});

test("substring match — 'denizcicekci' allAdDomains'de 'denizcicekcilik.com' olarak gelirse eşleşmeli", () => {
  const { tracker } = makeTmpTracker();
  // Target domain "denizcicekci" (kısa), sayfada "denizcicekcilik.com" görünüyor
  tracker.update(["denizcicekcilik.com", "other.com"], ["denizcicekci"]);
  assert.strictEqual(tracker.getMissed("denizcicekci"), 0);
});

test("substring match — kısa ad domain target uzun string'i match etmez (false positive guard)", () => {
  const { tracker } = makeTmpTracker();
  // Sayfada "cicek.com" görünüyor ama target "hizlicicek.com" — match etmemeli
  tracker.update(["cicek.com"], ["hizlicicek.com"]);
  assert.strictEqual(tracker.getMissed("hizlicicek.com"), 1, "hizlicicek.com görünmedi sayılmalı (cicek.com farklı domain)");
});

test("update: sayfada hiç reklam yoksa miss sayılmaz", () => {
  const { tracker } = makeTmpTracker();
  // 5 kez boş sayfa — exhausted olmamalı
  for (let i = 0; i < 5; i++) {
    tracker.update([], ["mycompetitor.com"]);
  }
  assert.strictEqual(tracker.isExhausted("mycompetitor.com"), false);
  assert.strictEqual(tracker.getMissed("mycompetitor.com"), 0);
});

test("update: sayfada reklam var ama target yok → miss sayılır", () => {
  const { tracker } = makeTmpTracker();
  for (let i = 0; i < 3; i++) {
    tracker.update(["other-competitor.com"], ["mycompetitor.com"]);
  }
  assert.strictEqual(tracker.isExhausted("mycompetitor.com"), true);
});

test("exhausted domain seen again → un-exhausted (sticky bug fixed)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
  const file = path.join(tmpDir, "budget-state.json");
  const { createTracker } = require("./budget-tracker");
  const tracker = createTracker({ stateFile: file, threshold: 3 });
  // Trigger exhaustion: 3 misses with other ads on page
  for (let i = 0; i < 3; i++) {
    tracker.update(["other.com"], ["target.com"]);
  }
  assert.equal(tracker.isExhausted("target.com"), true);

  // Target appears → should un-exhaust
  tracker.update(["target.com"], ["target.com"]);
  assert.equal(tracker.isExhausted("target.com"), false);
  assert.equal(tracker.getMissed("target.com"), 0);
  fs.unlinkSync(file);
});
