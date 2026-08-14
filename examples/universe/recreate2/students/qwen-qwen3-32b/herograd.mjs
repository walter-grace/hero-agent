class Value {
  constructor(data) {
    this.data = data;
    this.grad = 0;
    this._backward = () => {};
    this._prev = [];
  }

  get requires_grad() {
    return this._backward !== undefined;
  }

  add(other) {
    other = Value.of(other);
    const out = new Value(this.data + other.data);
    out._prev = [this, other];

    out._backward = () => {
      this.grad += out.grad;
      other.grad += out.grad;
    };

    return out;
  }

  mul(other) {
    other = Value.of(other);
    const out = new Value(this.data * other.data);
    out._prev = [this, other];

    out._backward = () => {
      this.grad += other.data * out.grad;
      other.grad += this.data * out.grad;
    };

    return out;
  }

  sub(other) {
    return this.add(other.neg());
  }

  div(other) {
    return this.mul(other.pow(-1));
  }

  neg() {
    return this.mul(-1);
  }

  pow(n) {
    const out = new Value(this.data ** n);
    out._prev = [this];

    out._backward = () => {
      this.grad += n * (this.data ** (n - 1)) * out.grad;
    };

    return out;
  }

  relu() {
    const out = new Value(this.data > 0 ? this.data : 0);
    out._prev = [this];

    out._backward = () => {
      if (out.data > 0) this.grad += out.grad;
    };

    return out;
  }

  tanh() {
    const t = Math.tanh(this.data);
    const out = new Value(t);
    out._prev = [this];

    out._backward = () => {
      this.grad += (1 - t * t) * out.grad;
    };

    return out;
  }

  exp() {
    const out = new Value(Math.exp(this.data));
    out._prev = [this];

    out._backward = () => {
      this.grad += out.data * out.grad;
    };

    return out;
  }

  backward() {
    const topo = [];
    const visited = new Set();

    function build_topo(v) {
      if (!visited.has(v)) {
        visited.add(v);
        for (const child of v._prev) {
          build_topo(child);
        }
        topo.push(v);
      }
    }

    build_topo(this);

    this.grad = 1;
    for (const v of topo.reverse()) {
      v._backward();
    }
  }

  static of(val) {
    return val instanceof Value ? val : new Value(val);
  }
}

class Neuron {
  constructor(nin, seed) {
    this.weights = Array(nin).fill().map((_, i) => {
      const r = (seed * 1664525 + i) % 2147483647;
      seed = r;
      return new Value((r / 2147483647) * 2 - 1);
    });
    this.bias = new Value(0);
  }

  forward(xs) {
    let act = xs[0].mul(this.weights[0]);
    for (let i = 1; i < xs.length; i++) {
      act = act.add(xs[i].mul(this.weights[i]));
    }
    return act.add(this.bias).tanh();
  }

  params() {
    return [...this.weights, this.bias];
  }
}

class Layer {
  constructor(nin, nout, seed) {
    this.neurons = Array(nout).fill().map((_, i) => 
      new Neuron(nin, seed + i)
    );
  }

  forward(xs) {
    const outs = this.neurons.map(n => n.forward(xs));
    return outs.length === 1 ? outs[0] : outs;
  }

  params() {
    return this.neurons.flatMap(n => n.params());
  }
}

class MLP {
  constructor(nin, layerSizes, seed = 123) {
    this.layers = [];
    let currentSize = nin;
    for (const size of layerSizes) {
      this.layers.push(new Layer(currentSize, size, seed));
      currentSize = size;
    }
    this.seed = seed;
  }

  forward(xs) {
    let out = xs;
    for (const layer of this.layers) {
      out = layer.forward(out);
    }
    return out;
  }

  params() {
    return this.layers.flatMap(l => l.params());
  }

  clone() {
    const clone = new MLP(this.layers[0].neurons[0].weights.length, 
                          this.layers.map(l => l.neurons.length),
                          this.seed);
    for (let i = 0; i < this.layers.length; i++) {
      const srcLayer = this.layers[i];
      const cloneLayer = clone.layers[i];
      for (let j = 0; j < srcLayer.neurons.length; j++) {
        const srcNeuron = srcLayer.neurons[j];
        const cloneNeuron = cloneLayer.neurons[j];
        cloneNeuron.weights = srcNeuron.weights.map(w => 
          new Value(w.data)
        );
        cloneNeuron.bias = new Value(srcNeuron.bias.data);
      }
    }
    return clone;
  }
}

async function trainXor({ epochs, lr }) {
  const net = new MLP(2, [4, 1]);
  const inputs = [[0,0],[0,1],[1,0],[1,1]];
  const targets = [-1, 1, 1, -1];

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Zero grads
    for (const p of net.params()) {
      p.grad = 0;
    }

    let loss = new Value(0);
    for (let i = 0; i < inputs.length; i++) {
      const xs = inputs[i].map(x => new Value(x));
      const target = new Value(targets[i]);
      const pred = net.forward(xs);
      const err = pred.sub(target).mul(pred.sub(target));
      loss = loss.add(err);
    }

    loss.backward();

    // SGD update
    for (const p of net.params()) {
      p.data -= lr * p.grad;
    }
  }

  return {
    loss: loss.data / 4,
    net
  };
}

export { Value, MLP, trainXor };