const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "clicks.json");

function load() {
  if (!fs.existsSync(DATA_PATH)) return {};
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function save(data) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

function record(domain, type) {
  const data = load();
  if (!data[domain]) data[domain] = { ads: 0, hits: 0 };
  data[domain][type] = (data[domain][type] || 0) + 1;
  save(data);
}

function getAll() {
  return load();
}

module.exports = { record, getAll };
