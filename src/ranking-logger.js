const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "rankings.json");

function load() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return JSON.parse(fs.readFileSync(LOG_PATH, "utf-8"));
}

function save(data) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(data, null, 2));
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
