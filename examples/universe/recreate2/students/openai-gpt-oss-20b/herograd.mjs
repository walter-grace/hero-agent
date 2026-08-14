// hero-grad autograd engine, tiny MLP for XOR
// compatible with Node.js ES module style

// deterministic linear‑congruential generator for reproducible weights
let _lcgSeed = 123456789;
function _lcg(){
  _lcgSeed = (_lcgSeed * 1664525 + 1013904223) >>> 0;
  return _lcgSeed / 0x100000000; // [0,1)
}
function randInRange(a,b){return a + (b-a)*_lcg();}

/**
 * Value: scalar node in an automatic differentiation graph
 * data – number
 * grad – gradient accumulated by backward()
 * _prev – previous Values that contributed to this Value
 * _backward – closure that propagates gradients to parents
 */
class Value{
  constructor(data){
    this.data = data;
    this.grad = 0;
    this._prev = [];
    this._backward = ()=>{};
  }

  // Record a parent for traversal
  _addPrev(v){ this._prev.push(v); }

  /** addition */
  add(b){
    if(!(b instanceof Value)) b = new Value(b);
    const out = new Value(this.data + b.data);
    out._addPrev(this); out._addPrev(b);
    out._backward = () => {
      this.grad += out.grad;
      b.grad += out.grad;
    };
    return out;
  }

  /** multiplication */
  mul(b){
    if(!(b instanceof Value)) b = new Value(b);
    const out = new Value(this.data * b.data);
    out._addPrev(this); out._addPrev(b);
    out._backward = () => {
      this.grad += b.data * out.grad;
      b.grad += this.data * out.grad;
    };
    return out;
  }

  /** subtraction via add + neg */
  sub(b){
    return this.add(b.neg());
  }

  /** division via mul + pow(-1) */
  div(b){
    return this.mul(b.pow(-1));
  }

  /** negative */
  neg(){
    const out = new Value(-this.data);
    out._addPrev(this);
    out._backward = () => {
      this.grad += -out.grad;
    };
    return out;
  }

  /** power, exponent is a plain number */
  pow(exp){
    const out = new Value(Math.pow(this.data, exp));
    out._addPrev(this);
    out._backward = () => {
      this.grad += exp * Math.pow(this.data, exp-1) * out.grad;
    };
    return out;
  }

  /** ReLU activation */
  relu(){
    const outVal = this.data > 0 ? this.data : 0;
    const out = new Value(outVal);
    out._addPrev(this);
    out._backward = () => {
      if(this.data > 0) this.grad += out.grad;
    };
    return out;
  }

  /** tanh activation */
  tanh(){
    const t = Math.tanh(this.data);
    const out = new Value(t);
    out._addPrev(this);
    out._backward = () => {
      this.grad += (1 - t*t) * out.grad;
    };
    return out;
  }

  /** exponential */
  exp(){
    const e = Math.exp(this.data);
    const out = new Value(e);
    out._addPrev(this);
    out._backward = () => {
      this.grad += e * out.grad;
    };
    return out;
  }

  /** utility: seeding gradients before backward */
  zeroGrad(){ this.grad = 0; }

  /** Backward pass via reverse topological order */
  backward(){
    // Build topological order via DFS
    const visited = new Set();
    const topo = [];
    function build(v){
      if(!visited.has(v)){
        visited.add(v);
        for(const p of v._prev){ build(p); }
        topo.push(v);
      }
    }
    build(this);
    // Seed gradient of loss node
    this.grad = 1;
    // Walk backwards: propagate gradients
    for(let i=topo.length-1; i>=0; --i){
      topo[i]._backward();
    }
  }
}

/** Neuron in an MLP layer */
class Neuron{
  constructor(inputSize){
    this.w = Array.from({length:inputSize},()=>new Value(randInRange(-1,1)));
    this.b = new Value(0);
  }
  forward(x){ // x is array of Value
    let sum = new Value(0);
    for(let i=0;i<this.w.length;i++){
      sum = sum.add(this.w[i].mul(x[i]));
    }
    sum = sum.add(this.b);
    return sum.tanh();
  }
}

/** Layer: array of Neurons */
class Layer{
  constructor(inputSize, numNeurons){
    this.neurons = Array.from({length:numNeurons},()=>new Neuron(inputSize));
  }
  forward(x){ // x is array of Value
    return this.neurons.map(neuron=>neuron.forward(x));
  }
}

/** Multilayer Perceptron */
class MLP{
  constructor(nin, layerSizes){
    this.layers = [];
    let prevSize = nin;
    for(const size of layerSizes){
      this.layers.push(new Layer(prevSize, size));
      prevSize = size;
    }
  }

  forward(x){ // x: array of numbers
    let out = x.map(v=>new Value(v));
    for(let l=0;l<this.layers.length;l++){
      const layerOut = this.layers[l].forward(out);
      // If last layer produces a single neuron, drop array
      if(l===this.layers.length-1 && layerOut.length===1){
        return layerOut[0];
      }
      out = layerOut;
    }
    return out; // fall back, should not happen
  }

  /** return all parameter Values */
  params(){
    const ps = [];
    for(const layer of this.layers){
      for(const neuron of layer.neurons){
        ps.push(...neuron.w, neuron.b);
      }
    }
    return ps;
  }
}

/** Train MLP on XOR: returns {loss, net} */
function trainXor({epochs=400, lr=0.2}={}){
  const inputs = [[0,0],[0,1],[1,0],[1,1]];
  const targets = [-1,1,1,-1];
  const net = new MLP(2, [4,1]);
  for(let epoch=0; epoch<epochs; epoch++){
    const allParams = net.params();
    // zero grads
    for(const p of allParams) p.zeroGrad();
    let loss = new Value(0);
    for(let i=0;i<inputs.length;i++){
      const pred = net.forward(inputs[i]);
      const diff = pred.sub(targets[i]);
      loss = loss.add(diff.pow(2));
    }
    const meanLoss = loss.div(inputs.length);
    // backward
    meanLoss.backward();
    // update params via SGD
    for(const p of allParams){
      p.data -= lr * p.grad;
    }
    if(epoch===epochs-1){
      return {loss: meanLoss.data, net};
    }
  }
}

export { Value, MLP, trainXor };
