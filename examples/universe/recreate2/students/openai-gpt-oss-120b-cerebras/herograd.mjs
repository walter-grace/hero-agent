// herograd.mjs – a tiny reverse‑mode autograd engine and an MLP that learns XOR
// No external dependencies, deterministic weight init, and a minimal API as required.

// ---------- deterministic random number generator ----------
// Linear Congruential Generator – reproducible across runs.
let _seed = 1337;
function _rand() {
  // Parameters from Numerical Recipes
  _seed = (_seed * 16807) % 2147483647;
  // Scale to (-1, 1)
  return (_seed / 2147483647) * 2 - 1;
}

// ---------- Value – scalar node in the computational graph ----------
class Value {
  constructor(data) {
    this.data = data;          // forward value (number)
    this.grad = 0;            // accumulated gradient
    this._prev = new Set();   // parent nodes
    this._backward = () => {}; // function to back‑propagate local gradients
  }

  // ----- internal helper to ensure a plain number becomes a Value -----
  static _ensure(v) {
    return v instanceof Value ? v : new Value(v);
  }

  // ----- basic arithmetic operations returning new Value nodes -----
  add(other) {
    other = Value._ensure(other);
    const out = new Value(this.data + other.data);
    out._prev = new Set([this, other]);
    out._backward = () => {
      this.grad += out.grad;
      other.grad += out.grad;
    };
    return out;
  }

  mul(other) {
    other = Value._ensure(other);
    const out = new Value(this.data * other.data);
    out._prev = new Set([this, other]);
    out._backward = () => {
      this.grad += other.data * out.grad;
      other.grad += this.data * out.grad;
    };
    return out;
  }

  // Negation via multiplication by -1 (uses mul's derivative)
  neg() {
    return this.mul(-1);
  }

  // Subtraction and division are expressed via the primitive ops
  sub(other) {
    return this.add(Value._ensure(other).neg());
  }

  div(other) {
    return this.mul(Value._ensure(other).pow(-1));
  }

  // Power with a numeric exponent (exponent is a plain number)
  pow(exp) {
    if (typeof exp !== "number") {
      throw new Error("Exponent must be a number");
    }
    const base = this.data;
    const out = new Value(Math.pow(base, exp));
    out._prev = new Set([this]);
    out._backward = () => {
      // d/dx x^n = n * x^(n-1)
      this.grad += exp * Math.pow(base, exp - 1) * out.grad;
    };
    return out;
  }

  // ReLU activation
  relu() {
    const out = new Value(this.data > 0 ? this.data : 0);
    out._prev = new Set([this]);
    out._backward = () => {
      if (out.data > 0) this.grad += out.grad;
    };
    return out;
  }

  // Tanh activation – cache the forward value for derivative
  tanh() {
    const t = Math.tanh(this.data);
    const out = new Value(t);
    out._prev = new Set([this]);
    out._backward = () => {
      // derivative: 1 - tanh^2(x)
      this.grad += (1 - t * t) * out.grad;
    };
    return out;
  }

  // Exponential function
  exp() {
    const e = Math.exp(this.data);
    const out = new Value(e);
    out._prev = new Set([this]);
    out._backward = () => {
      this.grad += e * out.grad; // derivative of exp is exp itself
    };
    return out;
  }

  // ----- back‑propagation -----
  backward() {
    // Build a topological ordering via DFS post‑order
    const visited = new Set();
    const topo = [];
    const build = (v) => {
      if (!visited.has(v)) {
        visited.add(v);
        v._prev.forEach(build);
        topo.push(v);
      }
    };
    build(this);
    // Seed gradient of the loss node
    this.grad = 1;
    // Reverse topological order to execute back‑propagation
    for (let i = topo.length - 1; i >= 0; i--) {
      topo[i]._backward();
    }
  }
}

// ---------- Neural network components ----------
class Neuron {
  constructor(nin) {
    this.weights = [];
    for (let i = 0; i < nin; i++) {
      this.weights.push(new Value(_rand())); // deterministic small init
    }
    this.bias = new Value(0);
  }

  // Forward pass: dot(w, x) + b then tanh activation
  forward(x) {
    // x is array of Value
    let out = this.bias;
    for (let i = 0; i < this.weights.length; i++) {
      out = out.add(this.weights[i].mul(x[i]));
    }
    return out.tanh();
  }
}

class MLP {
  // layerSizes is an array like [4,1] for a 2‑input network
  constructor(nin, layerSizes) {
    // Reset the deterministic RNG for each new network so that two nets start identically
    _seed = 42;
    this.layers = [];
    let prevSize = nin;
    for (const size of layerSizes) {
      const layer = [];
      for (let i = 0; i < size; i++) {
        layer.push(new Neuron(prevSize));
      }
      this.layers.push(layer);
      prevSize = size;
    }
  }

  // Input: plain numbers array – convert to Value objects internally
  forward(arr) {
    let cur = arr.map((v) => new Value(v));
    for (const layer of this.layers) {
      const next = [];
      for (const neuron of layer) {
        next.push(neuron.forward(cur));
      }
      cur = next;
    }
    // If the network ends with a single scalar, unwrap it for convenience
    return cur.length === 1 ? cur[0] : cur;
  }

  // Collect all trainable parameters (weights + biases)
  params() {
    const ps = [];
    for (const layer of this.layers) {
      for (const neuron of layer) {
        ps.push(...neuron.weights, neuron.bias);
      }
    }
    return ps;
  }
}

// ---------- Training XOR using the tiny autograd engine ----------
function trainXor({ epochs = 300, lr = 0.2 } = {}) {
  const net = new MLP(2, [4, 1]);
  const inputs = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  // Targets are -1 for 0, +1 for 1 (tanh range)
  const targets = [-1, 1, 1, -1];

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Build loss graph for this epoch
    let loss = new Value(0);
    for (let i = 0; i < inputs.length; i++) {
      const pred = net.forward(inputs[i]);
      const diff = pred.sub(targets[i]);
      const sq = diff.mul(diff);
      loss = loss.add(sq);
    }
    // Mean squared error (optional, scaling does not affect correctness)
    loss = loss.mul(0.25);

    // Zero gradients before back‑propagation
    for (const p of net.params()) p.grad = 0;
    // Back‑propagate
    loss.backward();
    // Gradient descent step
    for (const p of net.params()) {
      p.data -= lr * p.grad;
    }
  }

  // Compute final loss (mean squared error)
  let finalLoss = new Value(0);
  for (let i = 0; i < inputs.length; i++) {
    const pred = net.forward(inputs[i]);
    const diff = pred.sub(targets[i]);
    const sq = diff.mul(diff);
    finalLoss = finalLoss.add(sq);
  }
  finalLoss = finalLoss.mul(0.25);

  return { loss: finalLoss.data, net };
}

export { Value, MLP, trainXor };
