// E2BExecutor: a third executor backend for hero-agent, matching the LocalExecutor / DockerExecutor
// contract exactly (init/exec/write/read/cleanup/label). It runs every command and file operation
// inside an E2B cloud microVM (firecracker), so untrusted work (compiling generated Lean, fetching
// Mathlib) stays fully off the host. The shell tools and any runner bind to it unchanged.
//
// The `e2b` SDK is an OPTIONAL dependency (like viem): this module only imports it inside init(), so
// importing the harness without e2b installed never fails. init() reads E2B_API_KEY from env.
//
// Contract (identical to executor.mjs):
//   init()                       optional, called once before use; creates the sandbox
//   exec(cmd, { timeout })       -> { code, stdout, stderr }
//   write(path, contents)        -> { code }
//   read(path)                   -> string (or "read error: …")
//   cleanup()                    -> kills the sandbox
//   label()                      -> "e2b:<sandboxId>"

export class E2BExecutor {
  // timeoutMs: sandbox lifetime. Proofs run for minutes, so default generous (20 min) and allow
  //   override. Hobby E2B caps a sandbox at 1h; Pro at 24h. cmdTimeoutMs bounds a single command
  //   (Lean/Mathlib steps are slow, so this is large by default).
  constructor({ apiKey = process.env.E2B_API_KEY, template = process.env.E2B_TEMPLATE, timeoutMs = 20 * 60_000, cmdTimeoutMs = 15 * 60_000 } = {}) {
    this.apiKey = apiKey;
    this.template = template;                 // optional prebuilt template (e.g. Lean pre-cached)
    this.timeoutMs = timeoutMs;
    this.cmdTimeoutMs = cmdTimeoutMs;
    this.sbx = null;
  }

  async init() {
    if (this.sbx) return;
    if (!this.apiKey) throw new Error("E2BExecutor: set E2B_API_KEY (get one at https://e2b.dev/dashboard).");
    let Sandbox;
    try { ({ Sandbox } = await import("e2b")); }
    catch { throw new Error("E2BExecutor: the 'e2b' package is not installed. Run: npm install e2b"); }
    const opts = { apiKey: this.apiKey, timeoutMs: this.timeoutMs };
    // Sandbox.create(template?, opts): pass the template name only when one is configured.
    this.sbx = this.template ? await Sandbox.create(this.template, opts) : await Sandbox.create(opts);
  }

  async _ensure() { if (!this.sbx) await this.init(); return this.sbx; }

  async exec(cmd, { timeout } = {}) {
    const sbx = await this._ensure();
    const timeoutMs = timeout || this.cmdTimeoutMs;
    try {
      // requestTimeoutMs must exceed timeoutMs, otherwise the blocking HTTP call for a long command
      // gives up before the command does. run() throws on a non-zero exit, so normalize both paths.
      const r = await sbx.commands.run(cmd, { timeoutMs, requestTimeoutMs: timeoutMs + 30_000 });
      return { code: r.exitCode ?? 0, stdout: r.stdout || "", stderr: r.stderr || "" };
    } catch (e) {
      // CommandExitError carries exitCode/stdout/stderr; other errors surface as a stderr message.
      if (e && typeof e.exitCode === "number") return { code: e.exitCode, stdout: e.stdout || "", stderr: e.stderr || String(e.message || e) };
      return { code: 1, stdout: "", stderr: String(e?.message || e) };
    }
  }

  async write(path, content) {
    const sbx = await this._ensure();
    try { await sbx.files.write(path, String(content ?? "")); return { code: 0 }; }
    catch (e) {
      // Fall back to a base64 shell write if the fs API ever rejects the path (matches DockerExecutor).
      const b64 = Buffer.from(String(content ?? "")).toString("base64");
      return this.exec(`mkdir -p "$(dirname '${path}')" && printf %s '${b64}' | base64 -d > '${path}'`);
    }
  }

  async read(path) {
    const sbx = await this._ensure();
    try { return await sbx.files.read(path); }
    catch (e) { return `read error: ${e?.message || e}`; }
  }

  async cleanup() { try { await this.sbx?.kill(); } catch {} this.sbx = null; }

  label() { return `e2b:${this.sbx?.sandboxId || "uninitialized"}`; }
}

// ---- Lean 4 bootstrap in the sandbox --------------------------------------------------------
// The base E2B template has no Lean. This installs elan (the Lean toolchain manager) and a pinned
// Lean 4 toolchain, then scaffolds a lake project. Mathlib is LARGE and slow, so fetching its build
// cache is OPTIONAL (fullMathlib): a smoke test should not spend minutes and compute pulling it.
//
// Toolchain pin: leanprover/lean4:v4.15.0 with a matching Mathlib tag. Aristotle runs fixed
// Lean/Mathlib versions internally; those are not publicly pinned, so we choose a recent stable
// release and document it here. Change LEAN_TOOLCHAIN / MATHLIB_REV together to move versions.
export const LEAN_TOOLCHAIN = "leanprover/lean4:v4.15.0";
export const MATHLIB_REV = "v4.15.0";
export const PROOF_DIR = "/home/user/proof"; // lake project root inside the sandbox

export async function setupLean(executor, { fullMathlib = false, onLog = () => {} } = {}) {
  const log = (m) => onLog(m);

  // 1) Install elan + the pinned toolchain. elan's installer is idempotent and quick.
  log("installing elan + Lean " + LEAN_TOOLCHAIN);
  const install = await executor.exec(
    `set -e
     if ! command -v elan >/dev/null 2>&1; then
       curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o /tmp/elan-init.sh
       sh /tmp/elan-init.sh -y --default-toolchain none
     fi
     export PATH="$HOME/.elan/bin:$PATH"
     elan toolchain install ${LEAN_TOOLCHAIN}
     elan default ${LEAN_TOOLCHAIN}
     lean --version`,
    { timeout: 8 * 60_000 },
  );
  if (install.code !== 0) throw new Error(`setupLean: elan/Lean install failed:\n${install.stderr.slice(0, 1500)}`);
  log(install.stdout.trim());

  // 2) Scaffold a lake project. Ensure ~/.elan/bin is on PATH for every later shell command by
  //    appending it to ~/.profile (login shells) and ~/.bashrc; `sh -c` reads neither, so we also
  //    keep exporting it inline where it matters.
  await executor.exec(`grep -qs 'elan/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.elan/bin:$PATH"' >> "$HOME/.profile"`);
  const scaffold = await executor.exec(
    `set -e
     export PATH="$HOME/.elan/bin:$PATH"
     mkdir -p ${PROOF_DIR}
     cd ${PROOF_DIR}
     echo '${LEAN_TOOLCHAIN}' > lean-toolchain
     if [ ! -f lakefile.lean ] && [ ! -f lakefile.toml ]; then
       printf 'import Lake\\nopen Lake DSL\\n\\npackage proof\\n\\n@[default_target]\\nlean_lib Proof\\n' > lakefile.lean
     fi
     mkdir -p Proof
     [ -f Proof.lean ] || printf -- '-- proof entry point\\n' > Proof.lean
     lake --version`,
    { timeout: 3 * 60_000 },
  );
  if (scaffold.code !== 0) throw new Error(`setupLean: lake scaffold failed:\n${scaffold.stderr.slice(0, 1500)}`);

  if (!fullMathlib) {
    log("Mathlib skipped (pass fullMathlib to fetch it). Core Lean 4 is ready.");
    return { toolchain: LEAN_TOOLCHAIN, mathlib: false, dir: PROOF_DIR };
  }

  // 3) Optional heavy step: add Mathlib as a dependency and fetch its prebuilt cache so we do NOT
  //    recompile all of Mathlib (which takes far longer). `lake exe cache get` downloads the cache.
  log("adding Mathlib " + MATHLIB_REV + " and fetching build cache (slow)…");
  const mathlib = await executor.exec(
    `set -e
     export PATH="$HOME/.elan/bin:$PATH"
     cd ${PROOF_DIR}
     if ! grep -qs mathlib lakefile.lean 2>/dev/null; then
       printf 'import Lake\\nopen Lake DSL\\n\\npackage proof\\n\\nrequire mathlib from git "https://github.com/leanprover-community/mathlib4.git" @ "${MATHLIB_REV}"\\n\\n@[default_target]\\nlean_lib Proof\\n' > lakefile.lean
     fi
     lake update
     lake exe cache get
     lake build Mathlib.Tactic 2>&1 | tail -5 || true`,
    { timeout: 40 * 60_000 },
  );
  if (mathlib.code !== 0) throw new Error(`setupLean: Mathlib setup failed:\n${mathlib.stderr.slice(0, 2000)}`);
  log("Mathlib ready.");
  return { toolchain: LEAN_TOOLCHAIN, mathlib: true, dir: PROOF_DIR };
}
