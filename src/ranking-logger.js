const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "rankings.json");

function load() {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const raw = fs.readFileSync(LOG_PATH, "utf-8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(data) {
  try {
    fs.writeFileSync(LOG_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

function logRanking({ query, domain, page, position, clicked, timestamp }) {
  const data = load();
  data.push({
    query,
    domain,
    page,
    position,
    clicked,
    timestamp: timestamp || new Date().toISOString(),
  });
  save(data);
}

function logNotFound({ query, domain, pagesSearched, timestamp }) {
  const data = load();
  data.push({
    query,
    domain,
    page: null,
    position: null,
    pagesSearched,
    clicked: false,
    timestamp: timestamp || new Date().toISOString(),
  });
  save(data);
}

module.exports = { logRanking, logNotFound };
