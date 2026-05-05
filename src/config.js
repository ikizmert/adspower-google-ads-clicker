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
  const [searchPart, domainPart] = line.includes("@")
    ? [line.split("@")[0].trim(), line.split("@")[1].trim()]
    : [line.trim(), ""];
  const domains = domainPart
    ? domainPart.split("#").map((d) => d.trim().toLowerCase())
    : [];
  return { search: searchPart, domains };
}

module.exports = { config, queries, parseQuery };
