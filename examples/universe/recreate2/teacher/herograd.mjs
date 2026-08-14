// HeroGrad: a scalar autograd engine and a tiny MLP that learns XOR. Backpropagation from scratch.
// Every Value carries data, grad, and a closure that knows how to push gradient to its parents.

export class Value {
  constructor(data, parents = [], op = "") {
    this.data = data;
    this.grad = 0;
    this._backward = () => {};
    this._parents = parents;
    this._op = op;
  }
  static wrap(x) { return x instanceof Value ? x : new Value(x); }

  add(other) {
    other = Value.wrap(other);
    const out = new Value(this.data + other.data, [this, other], "+");
    out._backward = () => {
      // d(a+b)/da = 1, /db = 1 — gradient flows through unchanged. ACCUMULATE (+=), never assign:
      // a node used twice must receive gradient from both consumers.
      this.grad += out.grad;
      other.grad += out.grad;
    };
    return out;
  }
  mul(other) {
    other = Value.wrap(other);
    const out = new Value(this.data * other.data, [this, other], "*");
    out._backward = () => {
      this.grad += other.data * out.grad;  // d(ab)/da = b
      other.grad += this.data * out.grad;  // d(ab)/db = a
    };
    return out;
  }
  pow(n) { // n is a plain number, not a Value
    const out = new Value(this.data ** n, [this], `**${n}`);
    out._backward = () => { this.grad += n * this.data ** (n - 1) * out.grad; };
    return out;
  }
  neg() { return this.mul(-1); }
  sub(other) { return this.add(Value.wrap(other).neg()); }
  div(other) { return this.mul(Value.wrap(other).pow(-1)); }
  relu() {
    const out = new Value(Math.max(0, this.data), [this], "relu");
    out._backward = () => { this.grad += (out.data > 0 ? 1 : 0) * out.grad; };
    return out;
  }
  tanh() {
    const t = Math.tanh(this.data);
    const out = new Value(t, [this], "tanh");
    out._backward = () => { this.grad += (1 - t * t) * out.grad; };
    return out;
  }
  exp() {
    const e = Math.exp(this.data);
    const out = new Value(e, [this], "exp");
    out._backward = () => { this.grad += e * out.grad; };
    return out;
  }

  backward() {
    // Reverse-mode AD needs parents processed AFTER all their consumers. Build a topological
    // order once (DFS post-order), then walk it REVERSED from this node. Without this, a diamond
    // graph (one node feeding two paths that rejoin) gets a partial, wrong gradient.
    const topo = [];
    const seen = new Set();
    const build = (v) => {
      if (seen.has(v)) return;
      seen.add(v);
      for (const p of v._parents) build(p);
      topo.push(v);
    };
    build(this);
    this.grad = 1; // dL/dL = 1 seeds the chain
    for (let i = topo.length - 1; i >= 0; i--) topo[i]._backward();
  }
}

// ---- the tiny net ----
let _seed = 42;
const rand = () => { _seed = (_seed * 1103515245 + 12345) % 2147483648; return _seed / 2147483648 * 2 - 1; }; // deterministic

export class Neuron {
  constructor(nin, activation = "tanh") {
    this.w = Array.from({ length: nin }, () => new Value(rand()));
    this.b = new Value(0);
    this.activation = activation;
  }
  forward(xs) {
    let act = this.b;
    for (let i = 0; i < this.w.length; i++) act = act.add(this.w[i].mul(xs[i]));
    return this.activation === "tanh" ? act.tanh() : act.relu();
  }
  params() { return [...this.w, this.b]; }
}
export class Layer {
  constructor(nin, nout, activation) { this.neurons = Array.from({ length: nout }, () => new Neuron(nin, activation)); }
  forward(xs) { return this.neurons.map((n) => n.forward(xs)); }
  params() { return this.neurons.flatMap((n) => n.params()); }
}
export class MLP {
  constructor(nin, sizes) { // e.g. new MLP(2, [4, 1]) = 2 inputs, hidden 4, output 1, all tanh
    this.layers = [];
    let prev = nin;
    for (const s of sizes) { this.layers.push(new Layer(prev, s, "tanh")); prev = s; }
  }
  forward(xs) {
    let out = xs.map(Value.wrap);
    for (const l of this.layers) out = l.forward(out);
    return out.length === 1 ? out[0] : out;
  }
  params() { return this.layers.flatMap((l) => l.params()); }
}

// Train an MLP on XOR. Returns final mean squared loss.
export function trainXor({ epochs = 300, lr = 0.2 } = {}) {
  const X = [[0, 0], [0, 1], [1, 0], [1, 1]];
  const Y = [-1, 1, 1, -1]; // tanh output range: encode XOR as ±1
  const net = new MLP(2, [4, 1]);
  let loss;
  for (let e = 0; e < epochs; e++) {
    loss = new Value(0);
    for (let i = 0; i < X.length; i++) {
      const pred = net.forward(X[i]);
      loss = loss.add(pred.sub(Y[i]).pow(2));
    }
    // zero grads BEFORE backward — stale gradients from the last step otherwise accumulate forever
    for (const p of net.params()) p.grad = 0;
    loss.backward();
    for (const p of net.params()) p.data -= lr * p.grad; // plain SGD
  }
  return { loss: loss.data / 4, net };
}
