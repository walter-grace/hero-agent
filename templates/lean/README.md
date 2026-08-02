# Prebuilt E2B Lean template (optional)

This template bakes Lean 4 and a pre-cached Mathlib into an E2B sandbox image so `hero-agent prove`
starts compiling right away instead of installing the toolchain at runtime. It is a speed and cost
optimization, not a requirement. The default path is runtime bootstrap (`setupLean` in
`src/bench/e2b-executor.mjs`), which works on the stock E2B base image with no template.

## When to use it

Use the runtime bootstrap for smoke tests and one-off core-Lean proofs. Build this template when you
run many Mathlib-backed proofs and want to skip the multi-minute Mathlib cache fetch each time.

## Build it

Install the E2B CLI and authenticate, then build from this directory:

```
npm install -g @e2b/cli
e2b auth login
cd templates/lean
e2b template build --name hero-agent-lean --dockerfile e2b.Dockerfile
```

The build runs `lake exe cache get` and a warm-up `lake build Mathlib.Tactic`, so it takes a while and
produces a large image. When it finishes the CLI prints a template id.

## Use it

Point the executor at the template by name or id:

```
E2B_TEMPLATE=hero-agent-lean hero-agent prove "..." --full-mathlib
```

To wire it in code, pass `template` to `E2BExecutor` and skip the heavy step of `setupLean` (the cache
is already present):

```js
const ex = new E2BExecutor({ template: "hero-agent-lean" });
await ex.init();
await setupLean(ex, { fullMathlib: false }); // toolchain already present; this just scaffolds/verifies
```

## Versions

Keep `LEAN_TOOLCHAIN` and `MATHLIB_REV` in `e2b.Dockerfile` in sync with the same constants in
`src/bench/e2b-executor.mjs`. Current pin: Lean `leanprover/lean4:v4.15.0`, Mathlib `v4.15.0`.
