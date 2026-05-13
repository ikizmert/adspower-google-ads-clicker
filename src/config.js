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
  // Format: "search terms" [@/#]ad1[@/#]ad2... [!]hit1[!]hit2...
  // - @ ve # her ikisi de reklam (ad) marker — sırası önemli değil
  // - ! hit (organik takip) marker
  // Örnek: "kuşadası çiçek @a.com#b.com !x.com!y.com#z.com"
  //   ads:  [a.com, b.com, z.com]  ← @, #, # hepsi ad
  //   hits: [x.com, y.com]
  const trimmed = line.trim();
  const firstMarker = trimmed.search(/[@#!]/);
  if (firstMarker === -1) return { search: trimmed, adDomains: [], hitDomains: [] };

  const search = trimmed.substring(0, firstMarker).trim();
  const rest = trimmed.substring(firstMarker);

  // Tokenize: split by markers, keep marker info (whitespace allowed around markers)
  const tokens = rest.split(/\s*([@#!])\s*/).filter((s) => s.length > 0);

  const adDomains = [];
  const hitDomains = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const marker = tokens[i];
    const value = (tokens[i + 1] || "").trim().toLowerCase();
    if (!value) continue;
    if (marker === "@" || marker === "#") adDomains.push(value);
    else if (marker === "!") hitDomains.push(value);
  }

  return { search, adDomains, hitDomains };
}

module.exports = { get config() { return config; }, get queries() { return queries; }, parseQuery };
