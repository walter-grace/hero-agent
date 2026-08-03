// The pinned baseline training stack the replay harness ships into the sandbox.
//
// This is the GROUND TRUTH the val_bpb replay measures against. It is deliberately
// tiny and pure-Python (standard library only): no numpy, no torch, no pip, so it
// runs on a CPU E2B sandbox with the internet turned OFF. It proves the MECHANISM
// and the SECURITY properties of the harness, not research-grade results. A real
// deployment swaps this stack for nanochat/autoresearch on a GPU sandbox while
// keeping the exact same trust boundary (eval + val + seed pinned and hashed).
//
// Trust boundary:
//   PINNED (trusted, hashed, never editable by a contributed diff):
//     - eval.py          the scorer: computes val_bpb from the checkpoint on val data
//     - data/val.txt     the validation split
//     - data/vocab.json  the fixed vocabulary (keeps bpb comparable across runs)
//     - seed.json        the fixed seed + architecture contract + step budget
//   CANDIDATE-EDITABLE (the research surface):
//     - train.py         trains parameters for the FIXED architecture, writes checkpoint.json
//     - data/train.txt   the training split (changing training data is legitimate research)
//
// The model is a linear char-level context model (a generalized neural bigram, in the
// spirit of Karpathy's makemore): logits[j] = b[j] + sum_p W[p][ctx[p]][j], trained by
// minibatch SGD. It is real (deterministic, produces an honest cross-entropy) and fast
// (a run is a few seconds of pure Python). Because our vocab is ASCII, one char is one
// byte, so bits-per-char equals bits-per-byte here; a true byte-level LM makes them
// identical by construction. We document this rather than pretend it is a frontier eval.

// ---- corpus -----------------------------------------------------------------------------
// A fixed, structured, deterministic corpus. train and val are drawn from the SAME
// distribution so the model can actually learn and val_bpb is meaningful. Kept small so a
// pure-Python training run finishes in seconds.
const BASE =
  "the hero run funds one frontier open training run. " +
  "contributors send research distilled from agent memory. " +
  "the harness runs each artifact in isolation and measures val bpb. " +
  "lower bits per byte means the model predicts the next byte better. " +
  "reputation and payouts follow measured improvement, not trust. " +
  "a malicious diff must not be able to fake its own score. " +
  "the scorer, the validation data, and the seed are pinned and hashed. " +
  "only the training procedure is open to change. ";

function repeatTo(base, n) {
  let s = "";
  while (s.length < n) s += base;
  return s.slice(0, n);
}

export const TRAIN_TXT = repeatTo(BASE, 3000);
export const VAL_TXT = repeatTo(BASE, 800);

// Vocabulary: the sorted set of characters that appear in the corpus. Shipped as a pinned
// file so both train and eval agree on indexing and bpb stays comparable across runs.
export const VOCAB = [...new Set((TRAIN_TXT + VAL_TXT).split(""))].sort();

// ---- pinned config / architecture contract ---------------------------------------------
// block = context length (how many previous chars condition the next). This is part of the
// PINNED contract: eval.py rejects a checkpoint whose dims disagree, so a diff cannot
// silently change the scored architecture. steps/lr/batch/wd are BASELINE training
// hyperparameters; a research diff is free to change them inside train.py.
export const SEED_CFG = {
  seed: 1337,
  steps: 300,
  lr: 0.5,
  batch: 64,
  wd: 0.0,
  block: 2,
};

export const SEED_JSON = JSON.stringify(SEED_CFG, null, 2) + "\n";
export const VOCAB_JSON = JSON.stringify(VOCAB) + "\n";

// ---- train.py (CANDIDATE-EDITABLE) ------------------------------------------------------
export const TRAIN_PY = `# train.py  (CANDIDATE-EDITABLE research surface)
# Trains a tiny linear char-level LM for the FIXED architecture that eval.py scores,
# then writes checkpoint.json. A research diff may tune the TRAINING here (lr, steps,
# batch, weight decay, init, optimizer, training data). It must NOT change the scored
# architecture (eval.py rejects a shape mismatch) and must NOT touch eval.py, val.txt,
# vocab.json or seed.json (the harness re-hashes them and scans this diff).
import json, math, os, random

HERE = os.path.dirname(os.path.abspath(__file__))

def _read(p):
    with open(os.path.join(HERE, p)) as f:
        return f.read()

def _readj(p):
    return json.loads(_read(p))

cfg = _readj("seed.json")
# The harness pins the seed via HERO_SEED (it runs several seeds to measure the noise
# band). Falling back to the pinned base keeps a bare "python train.py" reproducible.
SEED  = int(os.environ.get("HERO_SEED",  cfg["seed"]))
STEPS = int(os.environ.get("HERO_STEPS", cfg["steps"]))
LR    = float(os.environ.get("HERO_LR",  cfg["lr"]))
BATCH = int(os.environ.get("HERO_BATCH", cfg["batch"]))
WD    = float(os.environ.get("HERO_WD",  cfg.get("wd", 0.0)))
random.seed(SEED)

# EDIT-ME: baseline training procedure below.

vocab = _readj("data/vocab.json")
stoi = {c: i for i, c in enumerate(vocab)}
V = len(vocab)
BLOCK = cfg["block"]

text = _read("data/train.txt")
data = [stoi[c] for c in text if c in stoi]
N = len(data)

# params: W[p] is a V x V table mapping the context char at position p to next-char logits.
W = [[[0.0] * V for _ in range(V)] for _ in range(BLOCK)]
b = [0.0] * V
for p in range(BLOCK):
    for i in range(V):
        row = W[p][i]
        for j in range(V):
            row[j] = random.gauss(0, 1) * 0.01

def forward(ctx):
    logits = list(b)
    for p in range(BLOCK):
        row = W[p][ctx[p]]
        for j in range(V):
            logits[j] += row[j]
    m = max(logits)
    exps = [math.exp(x - m) for x in logits]
    s = sum(exps)
    return [e / s for e in exps]

for step in range(STEPS):
    gW = [[[0.0] * V for _ in range(V)] for _ in range(BLOCK)]
    gb = [0.0] * V
    for _ in range(BATCH):
        i = random.randint(BLOCK, N - 1)
        ctx = data[i - BLOCK:i]
        t = data[i]
        probs = forward(ctx)
        for j in range(V):
            d = probs[j] - (1.0 if j == t else 0.0)
            gb[j] += d
            for p in range(BLOCK):
                gW[p][ctx[p]][j] += d
    scale = LR / BATCH
    for j in range(V):
        b[j] -= scale * gb[j]
    for p in range(BLOCK):
        for i in range(V):
            rw = W[p][i]
            rg = gW[p][i]
            for j in range(V):
                rw[j] -= scale * rg[j] + LR * WD * rw[j]

ckpt = {"dims": {"V": V, "block": BLOCK}, "vocab": vocab, "W": W, "b": b}
with open(os.path.join(HERE, "checkpoint.json"), "w") as f:
    json.dump(ckpt, f)
print("trained: seed=%d steps=%d lr=%s batch=%d wd=%s" % (SEED, STEPS, LR, BATCH, WD))
`;

// ---- eval.py (PINNED, TRUSTED) ----------------------------------------------------------
// The scorer. It reconstructs the SAME linear forward pass from the checkpoint's parameters
// and computes val_bpb on the PINNED val data. It validates the checkpoint dims and vocab
// against the pinned contract, so a candidate cannot change the scored architecture, and it
// never imports or runs train.py, so a candidate cannot inject code into scoring.
export const EVAL_PY = `# eval.py  (PINNED, TRUSTED scorer -- a contributed diff must never modify this file)
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))

def _read(p):
    with open(os.path.join(HERE, p)) as f:
        return f.read()

def _readj(p):
    return json.loads(_read(p))

cfg = _readj("seed.json")
BLOCK = cfg["block"]
vocab = _readj("data/vocab.json")
stoi = {c: i for i, c in enumerate(vocab)}
V = len(vocab)

val = _read("data/val.txt")
vdata = [stoi[c] for c in val if c in stoi]

ckpt = _readj("checkpoint.json")
# Contract checks: the candidate cannot change the architecture that is scored.
if ckpt.get("dims", {}).get("V") != V:
    raise SystemExit("checkpoint V mismatch (architecture is pinned)")
if ckpt.get("dims", {}).get("block") != BLOCK:
    raise SystemExit("checkpoint block mismatch (architecture is pinned)")
if ckpt.get("vocab") != vocab:
    raise SystemExit("checkpoint vocab mismatch (vocab is pinned)")
W = ckpt["W"]
b = ckpt["b"]
if len(W) != BLOCK or len(b) != V:
    raise SystemExit("checkpoint shape mismatch")
for t in W:
    if len(t) != V or any(len(r) != V for r in t):
        raise SystemExit("checkpoint weight shape mismatch")

total_bits = 0.0
n = 0
ln2 = math.log(2)
for i in range(BLOCK, len(vdata)):
    ctx = vdata[i - BLOCK:i]
    t = vdata[i]
    logits = list(b)
    for p in range(BLOCK):
        row = W[p][ctx[p]]
        for j in range(V):
            logits[j] += row[j]
    m = max(logits)
    s = sum(math.exp(x - m) for x in logits)
    logp = (logits[t] - m) - math.log(s)   # natural-log prob of the true next byte
    total_bits += -logp / ln2
    n += 1

bpb = total_bits / n if n else float("inf")
# The single trusted output. The harness parses only this line.
print(json.dumps({"val_bpb": bpb, "n": n}))
`;

// ---- file manifest ----------------------------------------------------------------------
// STACK_DIR is the project root inside the sandbox. PINNED_FILES are the trusted components
// the harness hashes and re-verifies; a diff that changes any of them is tampering.
export const STACK_DIR = "/home/user/stack";

// path (relative to STACK_DIR) -> contents. Written verbatim into the sandbox.
export function stackFiles() {
  return {
    "train.py": TRAIN_PY,
    "eval.py": EVAL_PY,
    "seed.json": SEED_JSON,
    "data/train.txt": TRAIN_TXT,
    "data/val.txt": VAL_TXT,
    "data/vocab.json": VOCAB_JSON,
  };
}

// The trusted set: these must be byte-identical before and after the diff is applied.
export const PINNED_FILES = ["eval.py", "seed.json", "data/val.txt", "data/vocab.json"];
