// Built-in tools. A tool = { def (OpenAI function schema), run(args) -> string|{text,media} }.
// The harness passes def[] to Hero Run and dispatches tool_calls back to run().
const BASE = process.env.HERO_RUN_URL || "https://herorunai.com";

export function builtinTools(provider) {
  return [
    {
      def: { type: "function", function: {
        name: "web_search",
        description: "Search the live web for current, factual information. Use for anything time-sensitive or not already in memory.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      } },
      // Routed to a live-search model (Perplexity Sonar) through Hero Run — no separate search key.
      async run({ query }) {
        const msg = await provider.chat({ model: "perplexity/sonar-pro", maxTokens: 700, messages: [{ role: "user", content: String(query || "") }] });
        return msg.content || "(no results)";
      },
    },
    {
      def: { type: "function", function: {
        name: "hero_generate",
        description: "Generate an image or an audio clip from a text prompt. Returns a URL.",
        parameters: { type: "object", properties: { kind: { type: "string", enum: ["image", "audio"] }, prompt: { type: "string" } }, required: ["kind", "prompt"] },
      } },
      async run({ kind, prompt }) {
        const r = await fetch(`${BASE}/api/run`, { method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": provider.apiKey },
          body: JSON.stringify({ model: "auto", kind: kind === "audio" ? "audio" : "image", input: String(prompt || "") }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) return `generation failed: ${d.error || r.status}`;
        const url = d.image || d.audio || "";
        return url ? { text: `generated ${kind}: ${url}`, media: { kind, url } } : "(no media)";
      },
    },
  ];
}
