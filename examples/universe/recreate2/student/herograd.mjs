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

    add(other) {
        other = other instanceof Value ? other : new Value(other);
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
        other = other instanceof Value ? other : new Value(other);
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
        return this.add(this.neg().add(other.neg()).mul(0).add(other.neg())); // Simple way: this + (-other)
    }
    
    // a - b = a + (-b)
    static subtract(a, b) {
        const bVal = b instanceof Value ? b : new Value(b);
        return a.add(bVal.neg());
    }

    div(other) {
        other = other instanceof Value ? other : new Value(other);
        return this.mul(other.pow(-1));
    }

    pow(n) {
        const out = new Value(Math.pow(this.data, n));
        out._prev.add(this);
        out._backward = () => {
            this.grad += n * Math.pow(this.data, n - 1) * out.grad;
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

// Redefining sub to match reasoning 5 exactly
Value.prototype.sub = function(other) {
    const o = other instanceof Value ? other : new Value(other);
    return this.add(o.neg());
};

class Neuron {
    constructor(nin, seedGen) {
        this.w = Array.from({ length: nin }, () => new Value(seedGen()));
        this.b = new Value(0);
    }

    forward(x) {
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
    constructor(nin, nout, seedGen) {
        this.neurons = Array.from({ length: nout }, () => new Neuron(nin, seedGen));
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
        // Deterministic LCG
        let seed = 42;
        const seedGen = () => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return (seed / 4294967296) * 2 - 1;
        };

        this.layers = [];
        let prevSize = nin;
        for (const size of layerSizes) {
            this.layers.push(new Layer(prevSize, size, seedGen));
            prevSize = size;
        }
    }

    forward(x) {
        let current = x.map(v => v instanceof Value ? v : new Value(v));
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
    const targets = [-1, 1, 1, -1];

    let finalLoss = 0;

    for (let epoch = 0; epoch < epochs; epoch++) {
        let totalLoss = new Value(0);
        
        // Zero gradients
        net.params().forEach(p => p.grad = 0);

        for (let i = 0; i < 4; i++) {
            const pred = net.forward(inputs[i]);
            const target = new Value(targets[i]);
            const diff = pred.sub(target);
            totalLoss = totalLoss.add(diff.pow(2));
        }

        const mse = totalLoss.mul(0.25);
        mse.backward();

        net.params().forEach(p => {
            p.data -= lr * p.grad;
        });

        if (epoch === epochs - 1) {
            finalLoss = mse.data;
        }
    }

    return { loss: finalLoss, net };
}

export { Value, MLP, trainXor };
