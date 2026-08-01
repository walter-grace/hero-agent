// Hero Run provider: the agent's brain. Hero Run is an OpenAI-compatible gateway that auto-routes
// each call to the best model across ~15 providers and bills in $HERO from your prepaid key, so the
// harness needs no per-model config and no per-provider keys: one base URL, one key, model "auto".
const BASE = process.env.HERO_RUN_URL || "https://herorunai.com";

export function heroRun({ apiKey = process.env.HERO_RUN_KEY, base = BASE } = {}) {
  if (!apiKey) throw new Error("Set HERO_RUN_KEY (mint one at " + base + "/keys).");
  async function chat({ model = "auto", messages, tools = null, toolChoice = "auto", maxTokens = 1024, temperature }) {
    const body = { model, messages, max_tokens: maxTokens };
    if (tools?.length) { body.tools = tools; body.tool_choice = toolChoice; }
    if (temperature != null) body.temperature = temperature;
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(`Hero Run: ${d.error?.message || d.error || r.status}`);
    const msg = d.choices?.[0]?.message || {};
    // Attach cost telemetry so the harness can measure real cost-per-task: charged_hero is the $HERO
    // debited for THIS call, resolved_model/gateway show what auto routed to (free-served = 0).
    msg.x_hero = d.x_hero || null;
    return msg;
  }
  return { chat, base, apiKey };
}

// $HERO → USD, fetched once (so cost-per-task can be reported in the same units as other harnesses).
let _priceCache = null;
export async function heroUsd(base = BASE) {
  if (_priceCache != null) return _priceCache;
  try { const m = await (await fetch(`${base}/api/market`)).json(); _priceCache = Number(m.price || m.priceUsd || 0) || 0; }
  catch { _priceCache = 0; }
  return _priceCache;
}

