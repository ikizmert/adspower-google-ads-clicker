// Modül seviyesi anlık sayaçlar - Ctrl+C anında doğru sayım için
// Hem index.js hem searcher.js aynı state'i paylaşır
const state = {
  totalClicked: 0,
  totalHits: 0,
  totalFailed: 0,
  completed: 0,
  maxRun: 0,
  stopReason: null,
  adsByDomain: {},
  hitsByDomain: {},
};

function recordAd(domain) {
  state.totalClicked++;
  state.adsByDomain[domain] = (state.adsByDomain[domain] || 0) + 1;
}

function recordHit(domain) {
  state.totalHits++;
  state.hitsByDomain[domain] = (state.hitsByDomain[domain] || 0) + 1;
}

module.exports = { state, recordAd, recordHit };
