// The held-out exam. Run against ANY herograd implementation: node exam.mjs <path-to-herograd.mjs>
// The student never sees this file. Passing means the implementation UNDERSTANDS backprop,
// not that it copied anything.
const path = process.argv[2];
if (!path) { console.error("usage: node exam.mjs <herograd.mjs>"); process.exit(1); }
const mod = await import(new URL(path, `file://${process.cwd()}/`).href);
const { Value, MLP, trainXor } = mod;

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : "  ← " + detail}`); };
const close = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

// 1. forward values
{
  const a = new Value(2), b = new Value(3);
  t("add forward", close(a.add(b).data, 5));
  t("mul forward", close(a.mul(b).data, 6));
  t("chain forward", close(a.mul(b).add(a).data, 8));
}
// 2. basic gradients
{
  const a = new Value(2), b = new Value(3);
  const c = a.mul(b); c.backward();
  t("mul grads", close(a.grad, 3) && close(b.grad, 2), `a.grad=${a.grad} b.grad=${b.grad}`);
}
// 3. THE DIAMOND: a used by two paths that rejoin. Wrong topo order or = instead of += fails this.
{
  const a = new Value(3);
  const b = a.mul(2);       // 2a
  const c = a.mul(a);       // a²  (a used twice within one op too)
  const d = b.add(c);       // 2a + a²  → dd/da = 2 + 2a = 8
  d.backward();
  t("diamond graph gradient", close(a.grad, 8), `a.grad=${a.grad}, want 8`);
}
// 4. numerical gradient check on a gnarly composite
{
  const f = (x) => {
    const v = new Value(x);
    const y = v.mul(v).add(v.tanh().mul(3)).sub(v.pow(3).mul(0.1));
    return { y, v };
  };
  const { y, v } = f(0.7);
  y.backward();
  const h = 1e-6;
  const num = (f(0.7 + h).y.data - f(0.7 - h).y.data) / (2 * h);
  t("numerical gradient check", close(v.grad, num, 1e-3), `analytic=${v.grad.toFixed(5)} numeric=${num.toFixed(5)}`);
}
// 5. relu gate
{
  const a = new Value(-1); const r = a.relu(); r.backward();
  t("relu blocks negative", close(r.data, 0) && close(a.grad, 0));
  const b = new Value(2); const r2 = b.relu(); r2.backward();
  t("relu passes positive", close(r2.data, 2) && close(b.grad, 1));
}
// 6. tanh derivative
{
  const a = new Value(0.5); const th = a.tanh(); th.backward();
  t("tanh grad = 1 - tanh²", close(a.grad, 1 - Math.tanh(0.5) ** 2));
}
// 7. gradient accumulation across two backward consumers
{
  const a = new Value(2);
  const s = a.add(a); // a used twice: ds/da = 2
  s.backward();
  t("reuse accumulates (+=)", close(a.grad, 2), `a.grad=${a.grad}, want 2`);
}
// 8. the MLP learns XOR
{
  const { loss, net } = trainXor({ epochs: 400, lr: 0.2 });
  const sign = (x) => (x > 0 ? 1 : -1);
  const preds = [[0,0],[0,1],[1,0],[1,1]].map((x) => sign(net.forward(x).data));
  const want = [-1, 1, 1, -1];
  const correct = preds.every((p, i) => p === want[i]);
  t("XOR converges (loss < 0.05)", loss < 0.05, `loss=${loss?.toFixed(4)}`);
  t("XOR all 4 cases correct", correct, `got ${JSON.stringify(preds)}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
