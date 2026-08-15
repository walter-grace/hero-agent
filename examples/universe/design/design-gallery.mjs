import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const { brief, results } = JSON.parse(readFileSync(here + "ui-results.json", "utf8"));
const usd = (h) => (h * 2.275e-7).toFixed(3);
const ok = results.filter((r) => r.ok);
writeFileSync(here + "design-gallery.html", `<!doctype html><html><head><meta charset="utf-8"><title>Dribbble → Workflow → UIs</title><style>
  :root{--stone:#EDE9DE;--ink:#232823;--green:#435D56;--card:#F7F4EC}
  *{box-sizing:border-box;margin:0} body{background:var(--stone);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui;padding:34px 20px}
  .wrap{max-width:1420px;margin:0 auto} h1{font-size:27px;letter-spacing:-.02em} h1 b{color:var(--green)}
  .brief{display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid #d8d2c2;border-radius:14px;padding:14px 16px;margin:14px 0}
  .brief b{font-size:15px} .brief i{font-style:normal;color:#6b7166;font-size:12px}
  .sw{display:flex;gap:4px} .sw span{width:26px;height:26px;border-radius:6px;border:1px solid rgba(0,0,0,.12)}
  .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .tab{border:1px solid #cfc8b6;background:var(--card);border-radius:999px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer}
  .tab.on{background:var(--green);color:#fff;border-color:var(--green)}
  .tab i{display:block;font-style:normal;font-weight:400;font-size:10px;opacity:.75}
  .stage{background:var(--card);border:1px solid #d8d2c2;border-radius:16px;padding:10px}
  iframe{width:100%;height:760px;border:none;border-radius:12px;background:#fff;display:none} iframe.on{display:block}
</style></head><body><div class="wrap">
  <h1>Dribbble → minted workflow → <b>three UIs</b></h1>
  <div class="brief"><div><b>${brief.title}</b><br><i>${brief.tags.slice(0, 8).join(" · ")}</i></div>
    <div class="sw">${brief.colors.map((c) => `<span style="background:${c}" title="${c}"></span>`).join("")}</div>
    <i>scraped by Python from <a href="${brief.url}">the shot</a> · workflow = agent #48 on Robinhood Chain</i></div>
  <div class="tabs">${ok.map((r, i) => `<button class="tab ${i === 0 ? "on" : ""}" data-i="${i}">${r.model.split("@")[0].split("/").pop()}<i>${r.secs}s · ⬡${r.cost.toLocaleString()} ($${usd(r.cost)})</i></button>`).join("")}</div>
  <div class="stage">${ok.map((r, i) => `<iframe data-i="${i}" src="uis/${r.slug}/index.html" class="${i === 0 ? "on" : ""}"></iframe>`).join("")}</div>
<script>const t=[...document.querySelectorAll(".tab")],f=[...document.querySelectorAll("iframe")];
t.forEach(b=>b.onclick=()=>{t.forEach(x=>x.classList.toggle("on",x===b));f.forEach(x=>x.classList.toggle("on",x.dataset.i===b.dataset.i));});</script>
</div></body></html>`);
console.log("design-gallery.html");
