// One app to compare them all: every model's Habit Grid, live and interactive, in one page.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const results = JSON.parse(readFileSync(here + "apps-results.json", "utf8"));
const usd = (h) => (h * 2.275e-7).toFixed(3);
const frames = [
  { label: "Teacher (Claude)", path: "teacher/habit-grid.html", meta: "the original · frontier" },
  ...results.filter((r) => r.ok).map((r) => ({ label: r.label, path: `apps/${r.id.replace(/[^a-z0-9]/gi, "-")}/habit-grid.html`, meta: `${r.secs}s · ⬡${r.cost.toLocaleString()} ($${usd(r.cost)})` })),
];
const failed = results.filter((r) => !r.ok);
writeFileSync(here + "app-gallery.html", `<!doctype html><html><head><meta charset="utf-8"><title>One Blueprint, Every Student</title><style>
  :root{--stone:#EDE9DE;--ink:#232823;--green:#435D56;--brass:#B4913E;--card:#F7F4EC}
  *{box-sizing:border-box;margin:0} body{background:var(--stone);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui;padding:36px 20px}
  .wrap{max-width:1420px;margin:0 auto} h1{font-size:28px;letter-spacing:-.02em} h1 b{color:var(--green)}
  .sub{color:#6b7166;margin:6px 0 20px;max-width:800px}
  .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  .tab{border:1px solid #cfc8b6;background:var(--card);border-radius:999px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer}
  .tab.on{background:var(--green);color:#fff;border-color:var(--green)}
  .tab i{display:block;font-style:normal;font-weight:400;font-size:10px;opacity:.75}
  .stage{background:var(--card);border:1px solid #d8d2c2;border-radius:16px;padding:10px;box-shadow:0 14px 44px rgba(35,40,35,.09)}
  iframe{width:100%;height:640px;border:none;border-radius:12px;background:#0f1311;display:none}
  iframe.on{display:block}
  .split{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .failed{margin-top:14px;color:#8a5a3f;font-size:12px}
  .mode{margin-left:auto}
</style></head><body><div class="wrap">
  <h1>One Blueprint, <b>Every Student</b></h1>
  <div class="sub">The same app, built independently by each model from one reasoning trace minted on Robinhood Chain (agent #46). Every frame below is live: click days, watch streaks, reload — each is that model's real product. Compare mode shows any student against the teacher.</div>
  <div class="tabs" id="tabs">${frames.map((f, i) => `<button class="tab ${i === 0 ? "on" : ""}" data-i="${i}">${f.label}<i>${f.meta}</i></button>`).join("")}
    <button class="tab mode" id="cmp">⇄ compare with teacher</button></div>
  <div class="stage" id="stage">${frames.map((f, i) => `<iframe data-i="${i}" src="${f.path}" class="${i === 0 ? "on" : ""}"></iframe>`).join("")}</div>
  ${failed.length ? `<div class="failed">Did not produce an app: ${failed.map((f) => `${f.label} (${f.err})`).join(" · ")}</div>` : ""}
<script>
  const tabs=[...document.querySelectorAll(".tab[data-i]")],ifr=[...document.querySelectorAll("iframe")];let cur=0,cmp=false;
  const render=()=>{tabs.forEach(t=>t.classList.toggle("on",+t.dataset.i===cur));
    const st=document.getElementById("stage");st.classList.toggle("split",cmp&&cur!==0);
    ifr.forEach(f=>{const i=+f.dataset.i;f.classList.toggle("on",i===cur||(cmp&&cur!==0&&i===0));});};
  tabs.forEach(t=>t.onclick=()=>{cur=+t.dataset.i;render();});
  document.getElementById("cmp").onclick=function(){cmp=!cmp;this.classList.toggle("on",cmp);render();};
</script></div></body></html>`);
console.log(`app-gallery.html · ${frames.length} live apps · ${failed.length} failures noted`);
