const { checkStatus, listProfiles } = require("./adspower");

async function main() {
  const alive = await checkStatus().catch(() => false);
  if (!alive) {
    console.error("AdsPower çalışmıyor!");
    process.exit(1);
  }

  const profiles = await listProfiles();
  if (profiles.length === 0) {
    console.log("Profil bulunamadı.");
    return;
  }

  console.log(`\n${profiles.length} profil bulundu:\n`);
  for (const p of profiles) {
    console.log(`  [${p.serial}] ${p.name} (${p.id})`);
  }
  console.log("");
}

main().catch(console.error);
