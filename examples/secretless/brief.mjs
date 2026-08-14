// The daily brief — an ORDINARY script. It reads process.env like any Node program ever written and
// has no idea the vault exists. That's the point: wrap it with `hero-agent vault run` and it gets
// its secrets injected at spawn, nothing on disk, code unmodified.
//
//   hero-agent vault run -- node brief.mjs
const key = process.env.HERO_RUN_KEY;
if (!key) { console.error("No HERO_RUN_KEY in env. Run me via: hero-agent vault run -- node brief.mjs"); process.exit(1); }

// Live facts, public endpoints.
const [models, treasury] = await Promise.all([
  fetch("https://herorunai.com/api/models").then((r) => r.json()),
  fetch("https://herorunai.com/api/treasury").then((r) => r.json()).catch(() => null),
]);
const count = models.models?.length ?? 0;
const newest = (models.models || []).filter((m) => m.created).sort((a, b) => b.created - a.created)[0];

// One cheap model call turns the facts into a brief.
const r = await fetch("https://herorunai.com/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: "cheapest",
    messages: [{ role: "user", content: `Write a two-line morning brief for the Hero Run operator. Facts: catalog serves ${count} models; newest arrival is ${newest?.name || "n/a"} (${newest?.id || ""}). Treasury claimable: ${treasury?.claimable?.token1 || "?"} HERO. Plain tone, no hype.` }],
  }),
});
const j = await r.json();
if (!r.ok) { console.error("model call failed:", j.error?.message || "error"); process.exit(1); }
console.log("── morning brief ──");
console.log(j.choices[0].message.content.trim());
