// Modül seviyesi anlık sayaçlar - Ctrl+C anında doğru sayım için
// Hem index.js hem searcher.js aynı state'i paylaşır
const state = {
  totalClicked: 0,
  totalHits: 0,
  totalFailed: 0,
  completed: 0,
  maxRun: 0,
  stopReason: null,
};

module.exports = { state };
