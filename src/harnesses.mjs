// One call, any harness. `hero-agent harness <name> "task"` runs a coding harness with Hero Run as
// its brain: the harness's own config gets pointed at herorunai.com/v1 (written only if missing,
// never clobbered), the API key comes from env → key file → wallet vault, and the task is passed to
// the harness's one-shot mode. The harness does the agenting; Hero Run does the thinking; the vault
// does the secrets.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, execSync } from "node:child_process";

const BASE = process.env.HERO_RUN_BASE || "https://herorunai.com";
const home = (...p) => join(homedir(), ...p);

const has = (bin) => { try { execSync(`command -v ${bin}`, { stdio: "ignore", shell: "/bin/zsh" }); return true; } catch { return false; } };

// Append a config block only when its anchor string is absent — additive, never destructive.
function ensureBlock(path, anchor, block) {
  mkdirSync(dirname(path), { recursive: true });
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.includes(anchor)) return false;
  writeFileSync(path, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + block);
  return true;
}

export const HARNESSES = {
  dsh: {
    label: "DeepSeek Harness",
    install: "runs via npx, nothing to install",
    available: () => true, // npx fetches it
    ensureConfig(model) {
      const p = home(".dsh", "settings.yaml");
      const a = ensureBlock(p, "hero-run:", `llm-pi-ai:
  providers:
    hero-run:
      apiKeyEnv: HERO_RUN_KEY
      api: openai-completions
      baseURL: ${BASE}/v1
      models:
        - id: auto
        - id: cheapest
        - id: openai/gpt-oss-120b
`);
      const b = ensureBlock(p, "agent-default-model:", `agent-default-model:
  provider: hero-run
  model: ${model}
`);
      return a || b ? p : null;
    },
    cmd: (task) => ["npx", ["--yes", "@deepseek-ai/dsh", "--profile", "headless", task]],
  },

  claude: {
    label: "Claude Code",
    install: "https://claude.com/claude-code",
    available: () => has("claude"),
    ensureConfig() { return null; }, // pure env override, no file
    cmd: (task, model, key) => ["claude", ["-p", task], {
      ANTHROPIC_BASE_URL: BASE,       // Claude Code calls /v1/messages, which Hero Run serves
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: model,
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1", // our catalog ids aren't in its model table
    }],
  },

  opencode: {
    label: "OpenCode",
    install: "npm i -g opencode-ai   (or: brew install sst/tap/opencode)",
    available: () => has("opencode"),
    ensureConfig(model) {
      // opencode's documented custom-provider shape (@ai-sdk/openai-compatible). Respect an
      // existing config in EITHER extension: if one exists, it's the user's — never write a
      // second file that would shadow or fight it.
      const p = home(".config", "opencode", "opencode.json");
      const pc = home(".config", "opencode", "opencode.jsonc");
      for (const f of [p, pc]) {
        if (existsSync(f)) {
          if (!readFileSync(f, "utf8").includes("hero-run"))
            console.error(`note: ${f} exists — add the hero-run provider there yourself (${BASE}/docs shows the block).`);
          return null;
        }
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          "hero-run": {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `${BASE}/v1`, apiKey: "{env:HERO_RUN_KEY}" },
            models: { auto: {}, cheapest: {}, "openai/gpt-oss-120b": {} },
          },
        },
        model: `hero-run/${model}`,
      }, null, 2) + "\n");
      return p;
    },
    cmd: (task) => ["opencode", ["run", task]],
  },

  grok: {
    label: "Grok Build",
    install: "https://x.ai (Grok Build CLI)",
    available: () => has("grok"),
    ensureConfig(model) {
      const p = home(".grok", "config.toml");
      return ensureBlock(p, "[model.hero-run]", `[model.hero-run]
model = "${model}"
base_url = "${BASE}/v1"
name = "Hero Run"
env_key = "HERO_RUN_KEY"

[models]
default = "hero-run"
`) ? p : null;
    },
    cmd: (task) => ["grok", ["-p", task]],
  },
};

// Launch: returns the child's exit code. `env` carries HERO_RUN_KEY (from the vault when needed).
export async function runHarness(name, task, { model = "auto", key, extraEnv = {} } = {}) {
  const h = HARNESSES[name];
  if (!h) throw new Error(`Unknown harness "${name}". Try: ${Object.keys(HARNESSES).join(", ")}`);
  if (!h.available()) throw new Error(`${h.label} isn't installed. ${h.install}`);
  const wrote = h.ensureConfig(model);
  if (wrote) console.error(`✓ pointed ${h.label} at Hero Run (${wrote})`);
  const [bin, args, envOverride] = h.cmd(task, model, key);
  const env = { ...process.env, HERO_RUN_KEY: key, ...extraEnv, ...(envOverride || {}) };
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (e) => { console.error(e.message); resolve(1); });
  });
}
