/**
 * HeroGrad: A scalar reverse-mode autograd engine.
 */

class Value {
    constructor(data) {
        this.data = data;
        this.grad = 0;
        this._backward = () => {};
        this._prev = new Set();
    }

    static wrap(v) {
        return v instanceof Value ? v : new Value(v);
    }

    add(other) {
        other = Value.wrap(other);
        const out = new Value(this.data + other.data);
        out._prev.add(this);
        out._prev.add(other);
        out._backward = () => {
            this.grad += out.grad;
            other.grad += out.grad;
        };
        return out;
    }

    mul(other) {
        other = Value.wrap(other);
        const out = new Value(this.data * other.data);
        out._prev.add(this);
        out._prev.add(other);
        out._backward = () => {
            this.grad += other.data * out.grad;
            other.grad += this.data * out.grad;
        };
        return out;
    }

    neg() {
        return this.mul(-1);
    }

    sub(other) {
        return this.add(Value.wrap(other).neg());
    }

    div(other) {
        return this.mul(Value.wrap(other).pow(-1));
    }

    pow(exponent) {
        // exponent must be a number
        const out = new Value(Math.pow(this.data, exponent));
        out._prev.add(this);
        out._backward = () => {
            this.grad += exponent * Math.pow(this.data, exponent - 1) * out.grad;
        };
        return out;
    }

    relu() {
        const out = new Value(this.data < 0 ? 0 : this.data);
        out._prev.add(this);
        out._backward = () => {
            this.grad += (out.data > 0 ? 1 : 0) * out.grad;
        };
        return out;
    }

    tanh() {
        const t = Math.tanh(this.data);
        const out = new Value(t);
        out._prev.add(this);
        out._backward = () => {
            this.grad += (1 - t * t) * out.grad;
        };
        return out;
    }

    exp() {
        const out = new Value(Math.exp(this.data));
        out._prev.add(this);
        out._backward = () => {
            this.grad += out.data * out.grad;
        };
        return out;
    }

    backward() {
        const topo = [];
        const visited = new Set();
        const buildTopo = (v) => {
            if (!visited.has(v)) {
                visited.add(v);
                v._prev.forEach(p => buildTopo(p));
                topo.push(v);
            }
        };
        buildTopo(this);

        this.grad = 1;
        for (let i = topo.length - 1; i >= 0; i--) {
            topo[i]._backward();
        }
    }
}

// Deterministic random for reproducibility
class LCG {
    constructor(seed = 42) {
        this.seed = seed;
    }
    next() {
        this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
        return (this.seed / 4294967296) * 2 - 1; // Range (-1, 1)
    }
}

class Neuron {
    constructor(nin, rng) {
        this.w = Array.from({ length: nin }, () => new Value(rng.next()));
        this.b = new Value(0);
    }
    forward(x) {
        // x is array of Values
        let act = this.b;
        for (let i = 0; i < this.w.length; i++) {
            act = act.add(this.w[i].mul(x[i]));
        }
        return act.tanh();
    }
    params() {
        return [...this.w, this.b];
    }
}

class Layer {
    constructor(nin,nout, rng) {
        this.neurons = Array.from({ length: nout }, () => new Neuron(nin, rng));
    }
    forward(x) {
        return this.neurons.map(n => n.forward(x));
    }
    params() {
        return this.neurons.flatMap(n => n.params());
    }
}

class MLP {
    constructor(nin, layerSizes) {
        const rng = new LCG();
        this.layers = [];
        let prevSize = nin;
        for (const size of layerSizes) {
            this.layers.push(new Layer(prevSize, size, rng));
            prevSize = size;
        }
    }
    forward(x) {
        // Wrap x inputs in Value
        let current = x.map(v => new Value(v));
        for (const layer of this.layers) {
            current = layer.forward(current);
        }
        return current.length === 1 ? current[0] : current;
    }
    params() {
        return this.layers.flatMap(l => l.params());
    }
}

function trainXor({ epochs = 400, lr = 0.2 }) {
    const net = new MLP(2, [4, 1]);
    const inputs = [[0, 0], [0, 1], [1, 0], [1, 1]];
    const targets = [-1, 1, 1, -1]; // tanh targets
    const params = net.params();

    let finalLoss = 0;

    for (let e = 0; e < epochs; e++) {
        // Reset gradients
        params.forEach(p => p.grad = 0);

        let totalLoss = new Value(0);
        for (let i = 0; i < 4; i++) {
            const pred = net.forward(inputs[i]);
            const diff = pred.sub(targets[i]);
            totalLoss = totalLoss.add(diff.pow(2));
        }

        totalLoss.backward();

        // SGD
        params.forEach(p => {
            p.data -= lr * p.grad;
        });

        if (e === epochs - 1) {
            finalLoss = totalLoss.data / 4;
        }
    }

    return { loss: finalLoss, net };
}

export { Value, MLP, trainXor };
