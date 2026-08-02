# Prebuilt E2B template with Lean 4 + Mathlib pre-cached. This is the PRODUCTION optimization for
# `hero-agent prove`: baking elan, the pinned toolchain, and the Mathlib build cache into the image
# means a proof run skips the multi-minute bootstrap (setupLean) and starts compiling immediately.
#
# It is OPTIONAL. The default path is runtime bootstrap (setupLean installs Lean on the base image),
# so hero-agent runs with no custom template. Build this only when you want faster, cheaper runs.
#
# Keep the toolchain/Mathlib versions here in sync with LEAN_TOOLCHAIN / MATHLIB_REV in
# src/bench/e2b-executor.mjs.

FROM e2bdev/code-interpreter:latest

ARG LEAN_TOOLCHAIN=leanprover/lean4:v4.15.0
ARG MATHLIB_REV=v4.15.0

USER root
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install elan (Lean toolchain manager) and the pinned toolchain.
RUN curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o /tmp/elan-init.sh \
    && sh /tmp/elan-init.sh -y --default-toolchain none
ENV PATH="/root/.elan/bin:${PATH}"
RUN elan toolchain install ${LEAN_TOOLCHAIN} && elan default ${LEAN_TOOLCHAIN} && lean --version

# Scaffold the lake project at /home/user/proof, add Mathlib, and fetch its prebuilt cache so proofs
# do not recompile all of Mathlib at runtime. `lake exe cache get` downloads the cache; the warm-up
# build compiles the tactic surface once so later builds are fast.
RUN mkdir -p /home/user/proof
WORKDIR /home/user/proof
RUN echo "${LEAN_TOOLCHAIN}" > lean-toolchain \
    && printf 'import Lake\nopen Lake DSL\n\npackage proof\n\nrequire mathlib from git "https://github.com/leanprover-community/mathlib4.git" @ "%s"\n\n@[default_target]\nlean_lib Proof\n' "${MATHLIB_REV}" > lakefile.lean \
    && mkdir -p Proof && printf -- '-- proof entry point\n' > Proof.lean \
    && lake update \
    && lake exe cache get \
    && lake build Mathlib.Tactic

# Make the toolchain visible to non-login shells used by the executor.
RUN echo 'export PATH="$HOME/.elan/bin:/root/.elan/bin:$PATH"' >> /etc/profile.d/elan.sh
