function selectProvider(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return null;
  const totalWeight = providers.reduce((sum, p) => sum + (p.weight || 0), 0);
  if (totalWeight <= 0) return providers[0];
  let r = Math.random() * totalWeight;
  for (const p of providers) {
    r -= (p.weight || 0);
    if (r <= 0) return p;
  }
  return providers[providers.length - 1];
}

function selectCity(provider) {
  const cities = provider && provider.cities;
  if (!Array.isArray(cities) || cities.length === 0) return null;
  return cities[Math.floor(Math.random() * cities.length)];
}

function composeProxyUser(provider, city, sid, lifeMinutes = 30) {
  const parts = [provider.base_user, "area-TR"];
  if (city) parts.push(`city-${city}`);
  parts.push(`session-${sid}`, `life-${lifeMinutes}`);
  return parts.join("_");
}

module.exports = { selectProvider, selectCity, composeProxyUser };
