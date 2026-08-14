// HeroGrad: Scalar reverse-mode autograd engine with XOR example

// Deterministic seeded random number generator (LCG)
class SeededRandom {
  constructor(seed = 42) {
    this.seed = seed;
  }

  // Returns random in range [0, 1]
  next() {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  // Returns random in range [min, max)
  uniform(min, max) {
    return min + this.next() * (max - min);
  }
}

// Core Value class: wraps scalar with autograd
export class Value {
  constructor(data, _children = [], _op = '') {
    this.data = data;
    this.grad = 0;
    this._backward = () => {}; // no-op by default
    this._prev = _children;    // parent values that produced this
    this._op = _op;            // for debugging/graph visualization
  }

  // Addition: a + b (handles both Value and number operands)
  add(other) {
    other = other instanceof Value ? other : new Value(other);
    const out = new Value(this.data + other.data, [this, other], '+');

    // Local derivative: d(a+b)/da = 1, d(a+b)/db = 1
    out._backward = () => {
      this.grad += out.grad;
      other.grad += out.grad;
    };

    return out;
  }

  // Multiplication: a * b
  mul(other) {
    other = other instanceof Value ? other : new Value(other);
    const out = new Value(this.data * other.data, [this, other], '*');

    // Local derivative: d(a*b)/da = b, d(a*b)/db = a
    out._backward = () => {
      this.grad += other.data * out.grad;
      other.grad += this.data * out.grad;
    };

    return out;
  }

  // Power: x ^ n (n must be a plain number, not a Value)
  pow(exponent) {
    if (typeof exponent !== 'number') {
      throw new Error('pow() requires a plain number exponent, not a Value');
    }
    const out = new Value(Math.pow(this.data, exponent), [this], `^${exponent}`);

    // Local derivative: d(x^n)/dx = n * x^(n-1)
    out._backward = () => {
      this.grad += exponent * Math.pow(this.data, exponent - 1) * out.grad;
    };

    return out;
  }

  // ReLU activation: max(0, x)
  relu() {
    const out = new Value(this.data > 0 ? this.data : 0, [this], 'ReLU');

    // Local derivative: 1 if x > 0, else 0
    out._backward = () => {
      this.grad += out.data > 0 ? out.grad : 0;
    };

    return out;
  }

  // Tanh activation: tanh(x)
  tanh() {
    const t = Math.tanh(this.data);
    const out = new Value(t, [this], 'tanh');

    // Local derivative: d(tanh)/dx = 1 - tanh²(x)
    // Cache the tanh value t (which is out.data) for backward
    out._backward = () => {
      this.grad += (1 - t * t) * out.grad;
    };

    return out;
  }

  // Exponential: e^x
  exp() {
    const out = new Value(Math.exp(this.data), [this], 'exp');

    // Local derivative: d(e^x)/dx = e^x = out.data
    out._backward = () => {
      this.grad += out.data * out.grad;
    };

    return out;
  }

  // Negation: -x (derived from mul)
  neg() {
    return this.mul(-1);
  }

  // Subtraction: a - b (derived from add + neg)
  sub(other) {
    return this.add(other instanceof Value ? other.neg() : -other);
  }

  // Division: a / b (derived from mul + pow)
  div(other) {
    if (other instanceof Value) {
      return this.mul(other.pow(-1));
    } else {
      return this.mul(Math.pow(other, -1));
    }
  }

  // Backward pass: compute gradients via reverse topological order
  backward() {
    // Build topological order via DFS post-order
    const topo = [];
    const visited = new Set();

    const buildTopo = (v) => {
      if (visited.has(v)) return;
      visited.add(v);
      for (const child of v._prev) {
        buildTopo(child);
      }
      topo.push(v); // post-order: children before parents
    };

    buildTopo(this);

    // Seed gradient at the loss node (dL/dL = 1)
    this.grad = 1;

    // Walk backward through topo order
    for (let i = topo.length - 1; i >= 0; i--) {
      topo[i]._backward();
    }
  }

  // String representation for debugging
  toString() {
    return `Value(data=${this.data.toFixed(4)}, grad=${this.grad.toFixed(4)})`;
  }
}

// Neuron: nin inputs -> 1 output with weights and bias
class Neuron {
  constructor(nin, rng) {
    this.w = [];
    for (let i = 0; i < nin; i++) {
      this.w.push(new Value(rng.uniform(-1, 1)));
    }
    this.b = new Value(0);
  }

  // Forward pass: dot(w, x) + b passed through tanh
  forward(x) {
    // Dot product
    let act = this.b; // start with bias
    for (let i = 0; i < this.w.length; i++) {
      const xi = x[i] instanceof Value ? x[i] : new Value(x[i]);
      act = act.add(this.w[i].mul(xi));
    }
    return act.tanh(); // tanh activation
  }

  // Return all parameters (weights + bias)
  params() {
    return [...this.w, this.b];
  }
}

// Layer: array of neurons
class Layer {
  constructor(nin, nout, rng) {
    this.neurons = [];
    for (let i = 0; i < nout; i++) {
      this.neurons.push(new Neuron(nin, rng));
    }
  }

  // Forward pass through all neurons
  forward(x) {
    const outs = [];
    for (const neuron of this.neurons) {
      outs.push(neuron.forward(x));
    }
    return outs;
  }

  // Return all parameters from all neurons
  params() {
    const ps = [];
    for (const neuron of this.neurons) {
      ps.push(...neuron.params());
    }
    return ps;
  }
}

// Multi-Layer Perceptron
export class MLP {
  constructor(nin, layerSizes) {
    const rng = new SeededRandom(42); // deterministic seed
    const sz = [nin, ...layerSizes];
    this.layers = [];

    for (let i = 0; i < layerSizes.length; i++) {
      this.layers.push(new Layer(sz[i], sz[i + 1], rng));
    }
  }

  // Forward pass through all layers
  forward(x) {
    let out = x;
    for (const layer of this.layers) {
      out = layer.forward(out);
    }
    // If single output, return the Value itself, not a 1-element array
    return Array.isArray(out) && out.length === 1 ? out[0] : out;
  }

  // Return all trainable parameters
  params() {
    const ps = [];
    for (const layer of this.layers) {
      ps.push(...layer.params());
    }
    return ps;
  }
}

// Train MLP on XOR problem
export function trainXor({ epochs = 300, lr = 0.2 } = {}) {
  // XOR inputs and targets (using -1/1 for tanh activation)
  const inputs = [[0, 0], [0, 1], [1, 0], [1, 1]];
  const targets = [-1, 1, 1, -1];

  // Create network: 2 inputs -> 4 hidden -> 1 output
  const net = new MLP(2, [4, 1]);

  // Training loop
  for (let epoch = 0; epoch < epochs; epoch++) {
    // Forward pass: compute sum of squared errors
    let loss = new Value(0);
    for (let i = 0; i < inputs.length; i++) {
      const pred = net.forward(inputs[i]);
      const target = targets[i];
      // Square error: (pred - target)²
      const diff = pred.sub(target);
      loss = loss.add(diff.mul(diff));
    }

    // Zero gradients before backward
    for (const p of net.params()) {
      p.grad = 0;
    }

    // Backward pass
    loss.backward();

    // SGD update
    for (const p of net.params()) {
      p.data -= lr * p.grad;
    }
  }

  // Compute final mean squared error
  let totalLoss = 0;
  for (let i = 0; i < inputs.length; i++) {
    const pred = net.forward(inputs[i]);
    const diff = pred.data - targets[i];
    totalLoss += diff * diff;
  }
  const meanLoss = totalLoss / inputs.length;

  return { loss: meanLoss, net };
}