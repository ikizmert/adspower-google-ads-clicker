// Test: AdsPower'ı API ile aç, Puppeteer bağlan, hiçbir şey yapma.
// Kullanıcı manuel olarak Google'da arama yapacak.
// Eğer captcha çıkarsa: sorun puppeteer.connect / CDP bağlantısı.
// Çıkmazsa: sorun bizim arama kodu (mouse, type, vs.).

const puppeteer = require("puppeteer-core");
const { config } = require("./config");
const { checkStatus, openBrowser } = require("./adspower");

async function main() {
  const profileSerial = process.argv[2];
  if (!profileSerial) {
    console.error("Kullanım: node src/test-passive.js <serial>");
    process.exit(1);
  }

  const alive = await checkStatus().catch(() => false);
  if (!alive) {
    console.error("AdsPower çalışmıyor!");
    process.exit(1);
  }

  // listProfiles ile serial -> id bul
  const res = await fetch(`${config.adspower.api_url}/api/v1/user/list?page=1&page_size=100`);
  const data = await res.json();
  const profile = data.data.list.find((p) => String(p.serial_number) === String(profileSerial));
  if (!profile) {
    console.error(`Serial ${profileSerial} bulunamadı`);
    process.exit(1);
  }

  console.log(`Profil açılıyor: #${profile.serial_number} (${profile.user_id})`);
  const { wsEndpoint } = await openBrowser(profile.user_id);
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

  console.log("Browser açıldı, Puppeteer bağlandı.");
  console.log("Şimdi sen manuel olarak Google'a git, ara yap.");
  console.log("Captcha çıkıyor mu kontrol et.");
  console.log("Bittiğinde Ctrl+C ile çık.");

  // Hiçbir şey yapma, sadece bekle
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("Hata:", e.message);
  process.exit(1);
});
