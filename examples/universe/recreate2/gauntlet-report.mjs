// Renders gauntlet-results.json into a single-file, brand-styled report: gauntlet.html
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const { results, when } = JSON.parse(readFileSync(here + "gauntlet-results.json", "utf8"));
const names = results.find((r) => r.tests?.length)?.tests.map((t) => t.name) || [];
const usd = (h) => (h * 2.275e-7).toFixed(4);
const perfect = results.filter((r) => r.passed === 12).length;

const row = (r) => {
  const pct = (r.passed / (r.total || 12)) * 100;
  const bar = `<div class="bar"><div class="fill ${r.passed === 12 ? "gold" : r.passed >= 8 ? "ok" : "bad"}" style="width:${pct}%"></div><span>${r.passed}/12</span></div>`;
  const cells = names.map((n) => {
    const t = r.tests?.find((x) => x.name === n);
    return `<td class="m ${t ? (t.ok ? "y" : "n") : "x"}">${t ? (t.ok ? "✓" : "✗") : "–"}</td>`;
  }).join("");
  return `<tr><td class="model"><b>${r.label}</b><i>${r.size} · ${r.note}</i></td><td>${bar}</td><td class="num">${r.secs}s</td><td class="num">⬡ ${r.cost.toLocaleString()}<i>$${usd(r.cost)}</i></td>${cells}</tr>`;
};

writeFileSync(here + "gauntlet.html", `<!doctype html><html><head><meta charset="utf-8"><title>The Blueprint Gauntlet</title><style>
  :root{--stone:#EDE9DE;--ink:#232823;--green:#435D56;--brass:#B4913E;--sage:#7fa893;--card:#F7F4EC}
  *{box-sizing:border-box;margin:0}
  body{background:var(--stone);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui;padding:48px 24px;display:grid;place-items:center}
  .wrap{max-width:1060px;width:100%}
  h1{font-size:30px;letter-spacing:-.02em} h1 b{color:var(--green)}
  .sub{color:#6b7166;margin:6px 0 6px;max-width:720px}
  .headline{display:inline-block;background:var(--green);color:#fff;border-radius:999px;padding:6px 16px;font-size:13px;font-weight:600;margin:10px 0 22px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid #d8d2c2;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(35,40,35,.08)}
  th{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8a9086;padding:12px 10px;text-align:left;border-bottom:1px solid #d8d2c2;background:#EFEBE0}
  th.rot{writing-mode:vertical-rl;transform:rotate(180deg);height:118px;padding:8px 3px;text-align:left}
  td{padding:12px 10px;border-bottom:1px solid #e6e0d2;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .model b{display:block} .model i,.num i{display:block;font-style:normal;font-size:11px;color:#8a9086}
  .num{white-space:nowrap;font-variant-numeric:tabular-nums}
  .bar{position:relative;width:150px;height:20px;background:#E2DCCB;border-radius:6px;overflow:hidden}
  .fill{height:100%;border-radius:6px}
  .fill.gold{background:var(--brass)} .fill.ok{background:var(--sage)} .fill.bad{background:#b46a4a}
  .bar span{position:absolute;inset:0;display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--ink)}
  td.m{text-align:center;font-weight:700;width:26px;padding:6px 2px}
  td.y{color:var(--green)} td.n{color:#b0402a} td.x{color:#b8b2a2}
  .foot{color:#8a9086;font-size:12px;margin-top:14px}
</style></head><body><div class="wrap">
  <h1>The Blueprint <b>Gauntlet</b></h1>
  <div class="sub">One reasoning trace, minted on Robinhood Chain (agent #47): how to build a backpropagation engine. Each model rebuilt it from the blueprint alone, then sat a hidden 12-test exam: gradient math, the diamond-graph trap, a numerical derivative check, and XOR trained to convergence.</div>
  <div class="headline">${perfect} of ${results.length} models rebuilt backprop perfectly — in seconds, for cents</div>
  <table><thead><tr><th>Student</th><th>Exam</th><th>Build</th><th>Cost</th>${names.map((n) => `<th class="rot">${n}</th>`).join("")}</tr></thead>
  <tbody>${results.map(row).join("")}</tbody></table>
  <div class="foot">Held-out exam: the students never saw the tests or the teacher's code, only the reasoning. ${when.slice(0, 10)} · herorunai.com</div>
</div></body></html>`);
console.log("report → gauntlet.html");
