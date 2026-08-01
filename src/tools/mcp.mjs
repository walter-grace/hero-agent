// Minimal MCP (Model Context Protocol) stdio client. Point the harness at any MCP server (filesystem,
// search, github, your own) and its tools become the agent's tools — picoclaw/Hermes extensibility.
// Config shape: [{ name, command, args?, env? }]. Returns tools in the harness's { def, run } shape.
import { spawn } from "node:child_process";

function connect({ command, args = [], env = {} }) {
  const proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", nextId = 1;
  const pending = new Map();
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch {}
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message || "mcp error")) : resolve(msg.result)));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`mcp timeout: ${method}`)); } }, 30000);
  });
  return { proc, call };
}

export async function mcpTools(servers = []) {
  const tools = [];
  for (const s of servers) {
    try {
      const { call } = connect(s);
      await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hero-agent", version: "0.1.0" } });
      const { tools: list = [] } = await call("tools/list", {});
      for (const t of list) {
        tools.push({
          def: { type: "function", function: { name: `${s.name}__${t.name}`, description: t.description || "", parameters: t.inputSchema || { type: "object", properties: {} } } },
          async run(args) {
            const res = await call("tools/call", { name: t.name, arguments: args });
            const parts = (res?.content || []).map((c) => c.text || c.data || "").filter(Boolean);
            return parts.join("\n") || JSON.stringify(res);
          },
        });
      }
      console.error(`[hero-agent] MCP '${s.name}': ${list.length} tools`);
    } catch (e) { console.error(`[hero-agent] MCP '${s.name}' failed: ${e.message}`); }
  }
  return tools;
}
