// hero-harness — the runtime that hosts an agent: the loop, the tool layer, the pluggable memory, and
// sub-agents. Provider-agnostic (anything with a .chat()) and memory-agnostic (LocalMemory or
// OnchainMemory). This is "what controls the agent"; the agent (agent.mjs) is just a configured
// Harness. Design leans Hermes: light, disk-first/pluggable memory, stateless sub-agents.
import { compact } from "./compaction.mjs";

export class Harness {
  constructor({ provider, memory, tools = [], system = "", compactEvery = 24, maxSteps = 6, model = "auto", onEvent }) {
    this.provider = provider;
    this.memory = memory;
    this.tools = tools;                          // [{ def, run }]
    this.system = system;
    this.compactEvery = compactEvery;
    this.maxSteps = maxSteps;
    // Routing mode is the primary cost knob: "auto" right-sizes each call (cheap models for easy
    // steps, frontier only when the prompt needs it); "cheapest" forces the cheapest trusted model.
    // Either way Hero Run prefers $0 free-served routes, so cost-per-task stays low without config.
    this.model = model;
    this.onEvent = onEvent || (() => {});        // (type, data) for CLIs/UIs to observe
    this._cost = 0;                              // $HERO charged, accumulated across the current task
  }
  _charge(msg) { const c = Number(msg?.x_hero?.charged_hero || 0); if (c) { this._cost += c; this.onEvent("cost", { hero: c, model: msg.x_hero?.resolved_model, gateway: msg.x_hero?.gateway }); } }

  // Assemble constant-cost context: system + ROOT index + only the raw turns since the ROOT.
  async _context(userText) {
    const root = await this.memory.getRoot();
    const recent = await this.memory.sinceRoot();
    const msgs = [{ role: "system", content: this.system + (root?.text ? `\n\n=== ROOT MEMORY INDEX (current merged state) ===\n${root.text}` : "") }];
    for (const e of recent) msgs.push({ role: e.role === "agent" ? "assistant" : "user", content: e.text });
    msgs.push({ role: "user", content: userText });
    return msgs;
  }

  // One turn with the tool loop. Persists the exchange to memory and compacts when the tail grows.
  async run(userText) {
    const messages = await this._context(userText);
    const toolDefs = this.tools.map((t) => t.def);
    const media = [];
    this._cost = 0;
    for (let step = 0; step < this.maxSteps; step++) {
      const msg = await this.provider.chat({ model: this.model, messages, tools: toolDefs.length ? toolDefs : null });
      this._charge(msg);
      if (!msg.tool_calls?.length) {
        const text = (msg.content || "").trim();
        await this._remember(userText, text);
        return { text, media, costHero: this._cost };
      }
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const tool = this.tools.find((t) => t.def.function.name === call.function.name);
        let args = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
        this.onEvent("tool", { name: call.function.name, args });
        let out = tool ? await tool.run(args).catch((e) => `tool error: ${e.message}`) : `unknown tool: ${call.function.name}`;
        if (out && typeof out === "object") { if (out.media) media.push(out.media); out = out.text || JSON.stringify(out); }
        messages.push({ role: "tool", tool_call_id: call.id, content: String(out).slice(0, 6000) });
      }
    }
    const fin = await this.provider.chat({ model: this.model, messages, tools: null });
    this._charge(fin);
    const text = (fin.content || "").trim();
    await this._remember(userText, text);
    return { text, media, costHero: this._cost };
  }

  async _remember(userText, replyText) {
    this.onEvent("remember", {});
    await this.memory.append([{ role: "user", text: userText }, { role: "agent", text: replyText }]);
    const since = await this.memory.sinceRoot();
    if (since.length >= this.compactEvery) await this.compact();
  }

  // Rebuild the ROOT index (faithful, newest-wins merge) and persist it. Raw is never deleted.
  async compact() {
    const since = await this.memory.sinceRoot();
    if (!since.length) return null;
    this.onEvent("compact", { entries: since.length });
    const root = await this.memory.getRoot();
    const next = await compact(this.provider, { priorRoot: root?.text || "", entries: since });
    if (next) await this.memory.setRoot(next);
    return next;
  }

  // Stateless sub-agent: a fresh Harness with the SAME tools/provider but NO memory writes — for
  // parallel specialist subtasks (research / draft / review) without polluting the main memory.
  async subagent(task, { system } = {}) {
    const scratch = { append: async () => {}, getRoot: async () => null, sinceRoot: async () => [], setRoot: async () => {} };
    const sub = new Harness({ provider: this.provider, memory: scratch, tools: this.tools, system: system || "You are a focused sub-agent. Complete the task and report only the result.", maxSteps: this.maxSteps, compactEvery: Infinity, onEvent: this.onEvent });
    const { text } = await sub.run(task);
    return text;
  }
}
