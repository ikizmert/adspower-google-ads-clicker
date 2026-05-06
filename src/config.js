const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const queriesPath = path.join(__dirname, "..", "queries.txt");
const queries = fs
  .readFileSync(queriesPath, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

function parseQuery(line) {
  let rest = line.trim();
  let adDomains = [];
  let hitDomains = [];

  // ! ile ayrılmış hit domainlerini topla
  const parts = rest.split("!");
  rest = parts[0].trim();
  for (let i = 1; i < parts.length; i++) {
    const d = parts[i].trim().toLowerCase();
    if (d) hitDomains.push(d);
  }

  // @ ile ayrılmış reklam domainlerini topla
  const adIndex = rest.indexOf("@");
  if (adIndex !== -1) {
    const adPart = rest.substring(adIndex + 1).trim();
    rest = rest.substring(0, adIndex).trim();
    adDomains = adPart.split("#").map((d) => d.trim().toLowerCase()).filter(Boolean);
  }

  return { search: rest, adDomains, hitDomains };
}

module.exports = { config, queries, parseQuery };
