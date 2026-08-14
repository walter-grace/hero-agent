// The products gallery: actually RUN every student's autograd engine — train XOR with THEIR classes,
// record the loss curve and predictions — and render everything (curves, truth tables, code, bugs)
// into one self-contained products.html. A crash is shown as the product it is.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const gauntlet = JSON.parse(readFileSync(here + "gauntlet-results.json", "utf8")).results;

async function evaluate(dir, label) {
  const file = here + "students/" + dir + "/herograd.mjs";
  if (!existsSync(file)) return { label, missing: true };
  const src = readFileSync(file, "utf8");
  const out = { label, src, lines: src.split("\n").length, bytes: src.length, losses: [], preds: null, error: null };
  try {
    const mod = await import(file + "?v=" + Date.now());
    const { Value, MLP } = mod;
    // Generic trainer against THEIR exports, mirroring the blueprint (their trainXor hides the curve).
    const X = [[0, 0], [0, 1], [1, 0], [1, 1]], Y = [-1, 1, 1, -1];
    const net = new MLP(2, [4, 1]);
    for (let e = 0; e < 400; e++) {
      let loss = new Value(0);
      for (let i = 0; i < 4; i++) {
        let p = net.forward(X[i]);
        if (Array.isArray(p)) p = p[0];
        loss = loss.add(p.sub(Y[i]).pow(2));
      }
      for (const w of net.params()) w.grad = 0;
      loss.backward();
      for (const w of net.params()) w.data -= 0.2 * w.grad;
      if (e % 10 === 0) out.losses.push(+(loss.data / 4).toFixed(4));
    }
    out.preds = X.map((x, i) => {
      let p = net.forward(x);
      if (Array.isArray(p)) p = p[0];
      return { in: x.join(","), got: +p.data.toFixed(2), want: Y[i], ok: Math.sign(p.data) === Y[i] };
    });
  } catch (e) { out.error = String(e.message || e).slice(0, 220); }
  return out;
}

const dirMap = { "Gemma 4 31B": "gemma-4-31b-cerebras", "gpt-oss-20b": "openai-gpt-oss-20b", "Qwen3 32B": "qwen-qwen3-32b", "GLM-4.7": "z-ai-glm-4-7-cerebras", "gpt-oss-120b": "openai-gpt-oss-120b-cerebras" };
const products = [{ ...(await evaluate("../teacher", "Teacher (Claude)")), teacher: true, meta: { passed: 12, secs: "—", cost: 0 } }];
// teacher lives elsewhere:
products[0] = { ...(await (async () => { const p = await evaluateTeacher(); return p; })()) };
async function evaluateTeacher() {
  const file = here + "teacher/herograd.mjs";
  const src = readFileSync(file, "utf8");
  const r = await evaluate("", "x").catch(() => null);
  // reuse evaluate's body inline for the teacher path:
  const out = { label: "Teacher (Claude)", teacher: true, src, lines: src.split("\n").length, bytes: src.length, losses: [], preds: null, error: null, meta: { passed: 12, secs: "—", cost: 0 } };
  try {
    const mod = await import(file);
    const { Value, MLP } = mod;
    const X = [[0, 0], [0, 1], [1, 0], [1, 1]], Y = [-1, 1, 1, -1];
    const net = new MLP(2, [4, 1]);
    for (let e = 0; e < 400; e++) {
      let loss = new Value(0);
      for (let i = 0; i < 4; i++) { let p = net.forward(X[i]); if (Array.isArray(p)) p = p[0]; loss = loss.add(p.sub(Y[i]).pow(2)); }
      for (const w of net.params()) w.grad = 0;
      loss.backward();
      for (const w of net.params()) w.data -= 0.2 * w.grad;
      if (e % 10 === 0) out.losses.push(+(loss.data / 4).toFixed(4));
    }
    out.preds = X.map((x, i) => { let p = net.forward(x); if (Array.isArray(p)) p = p[0]; return { in: x.join(","), got: +p.data.toFixed(2), want: Y[i], ok: Math.sign(p.data) === Y[i] }; });
  } catch (e) { out.error = String(e.message || e).slice(0, 220); }
  return out;
}
for (const g of gauntlet) {
  const dir = dirMap[g.label];
  if (!dir) continue;
  const p = await evaluate(dir, g.label);
  p.meta = { passed: g.passed, secs: g.secs, cost: g.cost, note: g.note };
  products.push(p);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const spark = (losses) => {
  if (!losses?.length) return "";
  const max = Math.max(...losses, 1);
  const pts = losses.map((l, i) => `${(i / (losses.length - 1)) * 220},${52 - (l / max) * 48}`).join(" ");
  return `<svg viewBox="0 0 220 56" class="spark"><polyline points="${pts}" fill="none" stroke="#435D56" stroke-width="2"/><text x="216" y="52" text-anchor="end" class="tl">final ${losses[losses.length - 1]}</text></svg>`;
};
const card = (p) => {
  const badge = p.teacher ? `<span class="badge gold">TEACHER · 12/12</span>` : `<span class="badge ${p.meta.passed === 12 ? "gold" : p.meta.passed >= 8 ? "ok" : "bad"}">${p.meta.passed}/12 · ${p.meta.secs}s · ⬡${(p.meta.cost || 0).toLocaleString()}</span>`;
  const body = p.error
    ? `<div class="err"><b>Runtime error while training with this engine:</b><br>${esc(p.error)}</div>`
    : `${spark(p.losses)}<table class="truth"><tr><th>in</th><th>out</th><th>want</th></tr>${p.preds.map((r) => `<tr class="${r.ok ? "" : "bad"}"><td>${r.in}</td><td>${r.got}</td><td>${r.want} ${r.ok ? "✓" : "✗"}</td></tr>`).join("")}</table>`;
  return `<div class="card"><div class="head"><b>${p.label}</b>${badge}</div><div class="body">${body}</div>
  <div class="meta">${p.lines} lines · ${(p.bytes / 1024).toFixed(1)}KB</div>
  <details><summary>view source</summary><pre>${esc(p.src)}</pre></details></div>`;
};

writeFileSync(here + "products.html", `<!doctype html><html><head><meta charset="utf-8"><title>The Products</title><style>
  :root{--stone:#EDE9DE;--ink:#232823;--green:#435D56;--brass:#B4913E;--card:#F7F4EC}
  *{box-sizing:border-box;margin:0} body{background:var(--stone);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui;padding:40px 22px}
  .wrap{max-width:1160px;margin:0 auto} h1{font-size:28px;letter-spacing:-.02em} h1 b{color:var(--green)}
  .sub{color:#6b7166;margin:6px 0 24px;max-width:760px}
  h2{font-size:19px;margin:34px 0 12px;color:var(--green)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid #d8d2c2;border-radius:14px;padding:16px}
  .head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}
  .badge{font-size:11px;font-weight:700;border-radius:999px;padding:3px 10px;color:#fff;white-space:nowrap}
  .gold{background:var(--brass)} .ok{background:#7fa893} .bad{background:#b46a4a}
  .spark{width:100%;height:56px;background:#EFEBE0;border-radius:8px;margin-bottom:8px} .tl{font-size:9px;fill:#8a9086}
  .truth{width:100%;border-collapse:collapse;font-size:12px} .truth th{text-align:left;color:#8a9086;font-size:10px;text-transform:uppercase}
  .truth td{padding:2px 6px 2px 0;font-variant-numeric:tabular-nums} .truth tr.bad td{color:#b0402a}
  .meta{color:#8a9086;font-size:11px;margin-top:8px}
  details{margin-top:8px} summary{cursor:pointer;font-size:12px;color:var(--green)}
  pre{background:#1d2420;color:#d9e2d7;border-radius:10px;padding:12px;font:11px/1.45 ui-monospace,monospace;overflow:auto;max-height:420px;margin-top:8px}
  .err{background:#f3e3dc;border:1px solid #d9b7a6;border-radius:10px;padding:10px;font-size:12px}
  .duo{display:grid;grid-template-columns:1fr 1fr;gap:14px} .duo .card{padding:8px}
  iframe{width:100%;height:520px;border:none;border-radius:10px;background:#0f1311}
  .cap{font-size:12px;color:#6b7166;padding:6px 8px 2px}
</style></head><body><div class="wrap">
  <h1>The <b>Products</b></h1>
  <div class="sub">Not scores — the artifacts themselves. Every autograd engine below was written by its model from the on-chain blueprint, and is being RUN live on this page's build: the loss curves and XOR truth tables come from training with each student's own classes.</div>
  <h2>HeroGrad — five engines, one blueprint</h2>
  <div class="grid">${products.map(card).join("")}</div>
  <h2>Habit Grid — teacher vs student (recreate #1)</h2>
  <div class="duo">
    <div class="card"><div class="cap"><b>Teacher (Claude)</b> — the original</div><iframe src="../recreate/teacher/habit-grid.html"></iframe></div>
    <div class="card"><div class="cap"><b>Student (Gemma 31B)</b> — rebuilt from the trace in 4s</div><iframe src="../recreate/student/habit-grid.html"></iframe></div>
  </div>
</div></body></html>`);
console.log(`products.html · ${products.length} engines evaluated`);
for (const p of products) console.log(`  ${p.label}: ${p.error ? "ERROR — " + p.error.slice(0, 60) : "final loss " + (p.losses?.at(-1) ?? "?") + " · XOR " + (p.preds?.filter((x) => x.ok).length ?? 0) + "/4"}`);
