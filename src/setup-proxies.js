const { config } = require("./config");
const API = config.adspower.api_url;

const PROXY = {
  host: "gw.aproxy.com",
  port: "2312",
  base_user: "ap-fcfvp9r45zxh_area-TR_city-AYDIN_life-5",
  password: "JEMKLwMO5Sa63ly1",
};

const PILOT_ID = config.adspower.pilot_profile_id;

function randomSid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let sid = "";
  for (let i = 0; i < 10; i++) sid += chars[Math.floor(Math.random() * chars.length)];
  return sid;
}

async function main() {
  const res = await fetch(`${API}/api/v1/user/list?page=1&page_size=100`);
  const data = await res.json();
  if (data.code !== 0) { console.error("Profiller alınamadı"); return; }

  const profiles = data.data.list.filter((p) => p.user_id !== PILOT_ID);
  console.log(`${profiles.length} profile proxy atanacak (pilot hariç)\n`);

  let success = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const p of profiles) {
    await sleep(1000);
    const sid = randomSid();
    const proxyUser = `${PROXY.base_user}_session-${sid}`;

    const updateRes = await fetch(`${API}/api/v1/user/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: p.user_id,
        user_proxy_config: {
          proxy_soft: "other",
          proxy_type: "http",
          proxy_host: PROXY.host,
          proxy_port: PROXY.port,
          proxy_user: proxyUser,
          proxy_password: PROXY.password,
        },
      }),
    });
    const updateData = await updateRes.json();

    if (updateData.code === 0) {
      console.log(`  #${p.serial_number} (${p.user_id}): session-${sid} ✓`);
      success++;
    } else {
      console.log(`  #${p.serial_number} (${p.user_id}): HATA — ${updateData.msg}`);
    }
  }

  console.log(`\n${success}/${profiles.length} profile proxy atandı.`);
}

main().catch(console.error);
