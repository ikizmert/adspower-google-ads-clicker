const test = require("node:test");
const assert = require("node:assert");
const { selectProvider, selectCity, composeProxyUser } = require("./proxy-rotation");

test("tek provider → her zaman o seçilir", () => {
  const providers = [{ name: "aproxy", weight: 100, cities: ["AYDIN"] }];
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(selectProvider(providers).name, "aproxy");
  }
});

test("weight 0 olan provider hiç seçilmez", () => {
  const providers = [
    { name: "a", weight: 100, cities: ["X"] },
    { name: "b", weight: 0, cities: ["Y"] },
  ];
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(selectProvider(providers).name, "a");
  }
});

test("weight 70/30 → 1000 örnekte ~%70 a / %30 b", () => {
  const providers = [
    { name: "a", weight: 70, cities: ["X"] },
    { name: "b", weight: 30, cities: ["Y"] },
  ];
  let aCount = 0;
  for (let i = 0; i < 1000; i++) {
    if (selectProvider(providers).name === "a") aCount++;
  }
  // %70 ± %5 tolerans
  assert.ok(aCount >= 650 && aCount <= 750, `aCount=${aCount}, beklenen 650-750`);
});

test("selectCity — provider'ın listesinden uniform random", () => {
  const provider = { cities: ["X", "Y", "Z"] };
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(selectCity(provider));
  assert.strictEqual(seen.size, 3);
});

test("selectCity — boş liste hata vermez, null döner", () => {
  const provider = { cities: [] };
  assert.strictEqual(selectCity(provider), null);
});

test("composeProxyUser — base + city + sid + life", () => {
  const provider = { base_user: "ap-foo123" };
  const user = composeProxyUser(provider, "ISTANBUL", "ABCDEF12");
  assert.strictEqual(user, "ap-foo123_area-TR_city-ISTANBUL_session-ABCDEF12_life-30");
});

test("composeProxyUser — city yoksa area-TR ile compose", () => {
  const provider = { base_user: "ap-foo" };
  const user = composeProxyUser(provider, null, "SID12345");
  assert.strictEqual(user, "ap-foo_area-TR_session-SID12345_life-30");
});
