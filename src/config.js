const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "config.json");
const queriesPath = path.join(__dirname, "..", "queries.txt");

let config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
let queries = loadQueries();

function loadQueries() {
  return fs
    .readFileSync(queriesPath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Config değişince otomatik reload
fs.watch(configPath, { persistent: false }, () => {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    if (!raw.trim()) return;
    config = JSON.parse(raw);
    console.log("⚙ config.json yeniden yüklendi");
  } catch {}
});

// Queries değişince otomatik reload
fs.watch(queriesPath, { persistent: false }, () => {
  try {
    queries = loadQueries();
    console.log(`⚙ queries.txt yeniden yüklendi (${queries.length} query)`);
  } catch {}
});

function parseQuery(line) {
  let rest = line.trim();
  let adDomains = [];
  let hitDomains = [];

  const parts = rest.split("!");
  rest = parts[0].trim();
  for (let i = 1; i < parts.length; i++) {
    // Hit grup içinde # ile çoklu domain (reklamla aynı format)
    const group = parts[i].trim();
    if (!group) continue;
    for (const d of group.split("#").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      hitDomains.push(d);
    }
  }

  const adIndex = rest.indexOf("@");
  if (adIndex !== -1) {
    const adPart = rest.substring(adIndex + 1).trim();
    rest = rest.substring(0, adIndex).trim();
    adDomains = adPart.split("#").map((d) => d.trim().toLowerCase()).filter(Boolean);
  }

  return { search: rest, adDomains, hitDomains };
}

module.exports = { get config() { return config; }, get queries() { return queries; }, parseQuery };
