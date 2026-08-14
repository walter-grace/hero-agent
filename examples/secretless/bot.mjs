// The secretless bot. There is no .env file. There are no keys in this code. The only thing on this
// machine is a vault token that can decrypt, and can do nothing else.
//
//   node bot.mjs                  (loadHeroEnv pulls the vault itself)
//   hero-agent vault run -- node bot.mjs   (or inject from the outside; same result)
import { loadHeroEnv } from "../../src/vault.mjs";

const loaded = await loadHeroEnv({ purpose: "secretless demo bot" });
console.log(`vault → injected ${loaded.length} secret(s): ${loaded.join(", ") || "(none)"}`);

const key = process.env.HERO_RUN_KEY;
if (!key) {
  console.error("\nThe vault has no HERO_RUN_KEY yet. Add one:\n  hero-agent vault set HERO_RUN_KEY=hr_live_…");
  process.exit(1);
}

// Prove the secret is real: authenticate with it.
const info = await (await fetch("https://herorunai.com/api/keys/info", { headers: { "x-api-key": key } })).json();
console.log(`key ${key.slice(0, 12)}… → balance ⬡ ${Math.round(info.balance ?? 0).toLocaleString()}`);

// And spend a fraction of a cent thinking with it.
const r = await fetch("https://herorunai.com/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: "cheapest",
    messages: [{ role: "user", content: "In one sentence: why is loading API keys from a wallet-encrypted vault safer than a .env file?" }],
  }),
});
const j = await r.json();
if (!r.ok) { console.error("model call failed:", j.error?.message || JSON.stringify(j).slice(0, 200)); process.exit(1); }
console.log("\nmodel says:", j.choices[0].message.content.trim());
