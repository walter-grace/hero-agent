// Hero Run provider for Prime Agent.
//
// Routes prime-agent's inference through Hero Run's OpenAI-compatible gateway: 500+ models across 16
// inference gateways, one base URL, one key, paid per call in $HERO. Every call funds one frontier
// open-source training run, which is the same thesis Prime Intellect is built on, so prime-agent
// running on this rail is that thesis in action.
//
// Install (drop-in extension):
//   1. Mint a key at https://herorunai.com/keys (connect a Base wallet, deposit $HERO -> hr_live_...).
//   2. export HERO_RUN_KEY=hr_live_...
//   3. Load this file as a prime-agent extension, then: prime-agent -> /login -> pick "Hero Run",
//      or run any model as `hero-run/auto` (the router picks a right-sized model at one flat price).
//
// It registers via prime-agent's documented pi.registerProvider() with api: "openai-completions",
// so it uses the stock streaming path. Models are discovered live from /v1/models.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE = process.env.HERO_RUN_URL || "https://herorunai.com";

// prime-agent reads reasoning models differently; flag the obvious ones so thinking is handled.
const looksReasoning = (id: string) => /(^|\/)(o1|o3|o4)|gpt-5|reason|thinking|:?r1\b|deepseek-r/i.test(id);

export default async function heroRun(pi: ExtensionAPI) {
  // Live model discovery. Fall back to just the router if the catalog can't be reached, so the
  // provider always registers and `hero-run/auto` always works.
  let list: Array<{ id: string; name?: string; context_window?: number; max_tokens?: number }> = [{ id: "auto" }];
  try {
    const r = await fetch(`${BASE}/v1/models`, { headers: process.env.HERO_RUN_KEY ? { Authorization: `Bearer ${process.env.HERO_RUN_KEY}` } : {} });
    if (r.ok) {
      const d: any = await r.json();
      const data = Array.isArray(d) ? d : d?.data;
      if (Array.isArray(data) && data.length) list = data;
    }
  } catch {
    /* offline / unreachable: keep the single "auto" entry */
  }

  // Keep the router modes first so they surface at the top of `prime-agent model list`.
  const ORDER = ["auto", "optimized", "fastest", "cheapest"];
  list.sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));

  pi.registerProvider("hero-run", {
    name: "Hero Run",
    baseUrl: `${BASE}/v1`,
    apiKey: "HERO_RUN_KEY", // env var name; hr_live_... minted at herorunai.com/keys, billed in $HERO
    api: "openai-completions",
    models: list.map((m) => ({
      id: m.id,
      name: m.id === "auto" ? "Hero (auto-router)" : (m.name || m.id),
      reasoning: looksReasoning(m.id),
      input: ["text", "image"],
      // Cost is metered in $HERO on the key, not per-token here, so report 0 to prime-agent's
      // token accounting and let the gateway do the real billing. `x_hero` in each response carries
      // the actual $HERO charged if you want to surface it.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window ?? 128000,
      maxTokens: m.max_tokens ?? 8192,
    })),
  });
}
