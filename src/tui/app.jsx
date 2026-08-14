// The Hero Run terminal app. One dynamic region (streaming answer, overlays, input, status bar)
// above an ever-growing <Static> scrollback, the same shape Claude Code uses: finished items are
// printed once and never re-rendered, so long sessions stay fast and native scrollback just works.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, Static, useInput, useApp, useStdout } from "ink";
import { Banner, Thinking, UserLine, AssistantBlock, SysBlock, Picker, Md, Chip } from "./ui.jsx";
import { BRASS, MINERAL, STEEL, STONE, EMBER, PAPER } from "./theme.mjs";
import {
  loadKey, saveKey, keyInfo, loadSettings, saveSettings, listModels, streamChat,
  walletInfo, hasWallet, listAgents, readMemory, writeMemory, readChannel, sendChannel, BASE,
  vaultBootKey, vaultOps, agentTurn, cerebrasModels,
} from "./api.mjs";
import { universeReview, mintLesson, recallLessons, lessonsBlock } from "./universe.mjs";

const COMMANDS = [
  { name: "/help", desc: "commands and keys" },
  { name: "/model", desc: "pick the model (auto routes per call)" },
  { name: "/models", desc: "list every model on the network" },
  { name: "/balance", desc: "key balance and wallet gas" },
  { name: "/agents", desc: "your on-chain agents" },
  { name: "/agent", desc: "set the working agent: /agent 26" },
  { name: "/recall", desc: "read the agent's recent memory" },
  { name: "/remember", desc: "mint a note (or the last exchange) to memory" },
  { name: "/channel", desc: "read a channel: /channel 25" },
  { name: "/send", desc: "message a channel: /send 25 hello" },
  { name: "/stats", desc: "this session: turns, tokens, speed, spend" },
  { name: "/key", desc: "set a new hr_live_ inference key" },
  { name: "/vault", desc: "wallet secrets: ls · set N=V · get N · rm N · login <token>" },
  { name: "/tools", desc: "toggle agent mode (shell, files, web search with y/n approval)" },
  { name: "/auto", desc: "auto-approve every tool, no prompts (this session)" },
  { name: "/turbo", desc: "pick any Cerebras-served model at wafer speed" },
  { name: "/learn", desc: "Universe reviews the last turn, mints a lesson:: to your agent (auto = every turn)" },
  { name: "/clear", desc: "clear the conversation" },
  { name: "/exit", desc: "leave" },
];

const SPARK = " ▁▂▃▄▅▆▇█";
const sparkline = (vals, width = 24) => {
  const v = vals.slice(-width);
  if (!v.length) return "";
  const max = Math.max(...v, 1);
  return v.map((x) => SPARK[Math.min(8, Math.round((x / max) * 8))]).join("");
};

const fmtHero = (n) => (n == null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);

export default function App({ version }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;

  // scrollback
  const [items, setItems] = useState([]);           // finished blocks
  const idRef = useRef(0);
  const push = useCallback((it) => setItems((prev) => [...prev, { id: ++idRef.current, ...it }]), []);

  // session
  const settings = useRef(loadSettings());
  const [key, setKey] = useState(loadKey);
  const [model, setModel] = useState(settings.current.model || "auto");
  const [agentId, setAgentId] = useState(settings.current.agentId || null);
  const [bal, setBal] = useState(null);
  const [spent, setSpent] = useState(0);
  const convo = useRef([]);                          // [{role, content}] chat history for the model

  // input editor
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const histRef = useRef({ list: [], idx: -1, draft: "" });

  // async states
  const [live, setLive] = useState(null);            // streaming text
  const [thinking, setThinking] = useState(null);    // {startedAt, note}
  const statsRef = useRef({ turns: 0, tokens: 0, seconds: 0, tps: [] });
  const abortRef = useRef(null);
  const [overlay, setOverlay] = useState(null);      // {title, items, filter, sel, onPick}
  const [setup, setSetup] = useState(!loadKey());    // first-run key wizard
  const [toolsOn, setToolsOn] = useState(true);       // agent mode: shell/files/web with approval
  const [pendingTool, setPendingTool] = useState(null); // { name, args, resolve } awaiting y/a/n
  const alwaysRef = useRef(new Set());                // tool names auto-approved this session
  const autoRef = useRef(false);                      // /auto: approve every tool, no prompts
  const preTurboRef = useRef(null);                   // model to restore when /turbo toggles off
  const lastTurnRef = useRef(null);                   // { task, trace, answer } of the last agent turn
  const lessonsRef = useRef({ list: [], loadedFor: null }); // earned lessons cache per agent
  const learnAutoRef = useRef(false);                 // /learn auto: Universe reviews every turn

  const slashOpen = !setup && !overlay && input.startsWith("/") && !input.includes(" ");
  const slashItems = slashOpen ? COMMANDS.filter((c) => c.name.startsWith(input.trim())) : [];
  const [slashSel, setSlashSel] = useState(0);
  useEffect(() => { setSlashSel(0); }, [input]);

  // key balance refresh (on boot and after each paid turn)
  const refreshBal = useCallback(async (k = key) => {
    if (!k) return;
    try { const info = await keyInfo(k); setBal(info.balance ?? info.remaining ?? null); } catch {}
  }, [key]);
  useEffect(() => { refreshBal(); }, [refreshBal]);

  // Balance-aware key boot. The naive chain (env → key file → vault) once picked a drained key
  // file (44 $HERO) over a funded vault key and greeted the user with an inference error. Now: if
  // the local key is missing OR nearly empty, check the vault and take whichever key can actually
  // pay for a reply.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const cur = loadKey();
        const curBal = cur ? (await keyInfo(cur).catch(() => null))?.balance ?? null : null;
        if (live && curBal != null) setBal(curBal);
        if (cur && (curBal == null || curBal >= 2000)) return; // local key is healthy; keep it
        const vk = await vaultBootKey();
        if (!live || !vk || vk === cur) return;
        const vBal = (await keyInfo(vk).catch(() => null))?.balance ?? null;
        if (vBal == null || (curBal != null && vBal <= curBal)) return;
        setKey(vk); setSetup(false); setBal(vBal);
        sys("vault", cur
          ? `Saved key is nearly empty (${fmtHero(curBal)} $HERO) — switched to your wallet vault key: ${fmtHero(vBal)} $HERO ready.`
          : "HERO_RUN_KEY loaded from your wallet vault. Zero local config.");
      } catch {}
    })();
    return () => { live = false; };
  }, []); // once, at boot


  const sys = useCallback((title, lines, error = false) => push({ kind: "sys", title, lines: Array.isArray(lines) ? lines : [String(lines)], error }), [push]);

  // ---- chat turn ----
  const ask = useCallback(async (prompt) => {
    convo.current.push({ role: "user", content: prompt });
    push({ kind: "user", text: prompt });
    const startedAt = Date.now();
    setThinking({ startedAt });
    setLive("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (toolsOn) {
        // Agent mode: the terminal-agent loop. Tool lines land in the transcript as they happen;
        // risky calls suspend on the approval gate until y/a/n.
        // Earned lessons ride the system prompt: the student starts every session with everything
        // the Universe has ever taught this agent. Loaded once per agent, refreshed on new mints.
        if (agentId && lessonsRef.current.loadedFor !== agentId) {
          lessonsRef.current = { list: await recallLessons(agentId).catch(() => []), loadedFor: agentId };
          if (lessonsRef.current.list.length) sys("universe", `${lessonsRef.current.list.length} earned lesson(s) loaded from agent #${agentId}.`);
        }
        const turnTrace = [];
        lastTurnRef.current = { task: prompt, trace: turnTrace, answer: "" };
        const sysPrompt = lessonsBlock(lessonsRef.current.list) + `\n\nYou are Hero, a terminal agent on the user's macOS machine. Working directory: ${process.cwd()}. You have tools: shell (run commands, 30s limit), read_file, write_file, web_search. LOOK instead of guessing: when asked about files, the system, or anything on this machine, use the tools. Shell discipline: append 2>/dev/null to noisy commands; for disk usage prefer du -xh -d 2 and targeted find with -size +200M; NEVER scan / or the whole home tree file-by-file; no sudo. Be concise; answer in markdown; never invent command output.`;
        const out = await agentTurn({
          key, model, cwd: process.cwd(), signal: ctrl.signal,
          messages: [{ role: "system", content: sysPrompt }, ...convo.current.slice(-24)],
          onTool: (name, args) => {
            turnTrace.push({ name, args });
            push({ kind: "sys", title: null, lines: [`· ${name}(${JSON.stringify(args).slice(0, 90)})`], error: false });
            setThinking({ startedAt: Date.now(), note: name }); // live elapsed while the tool runs
          },
          approve: (name, args) => new Promise((resolveA) => {
            if (autoRef.current || alwaysRef.current.has(name)) return resolveA(true);
            setPendingTool({ name, args, resolve: resolveA });
          }),
        });
        convo.current.push({ role: "assistant", content: out.text });
        const secs = (Date.now() - startedAt) / 1000;
        const st = statsRef.current;
        st.turns += 1; st.seconds += secs;
        push({
          kind: "assistant", text: out.text,
          meta: { model: out.model || model, cost: out.costHero ? `${fmtHero(out.costHero)} $HERO` : "", secs: secs.toFixed(1), tps: null },
        });
        if (out.costHero) { setSpent((s) => s + out.costHero); setBal((b) => (b == null ? b : Math.max(0, b - out.costHero))); }
        lastTurnRef.current.answer = out.text;
        if (learnAutoRef.current && agentId) {
          universeReview({ key, task: prompt, trace: turnTrace, answer: out.text }).then(async ({ lesson, cost }) => {
            if (cost) { setSpent((s) => s + cost); setBal((b) => (b == null ? b : Math.max(0, b - cost))); }
            if (!lesson) return;
            const hash = await mintLesson(agentId, lesson);
            lessonsRef.current.list.push(lesson);
            sys("universe", [`Lesson minted to agent #${agentId}:`, `  ${lesson}`, `tx ${hash.slice(0, 14)}…`]);
          }).catch(() => {});
        }
        return;
      }
      let first = true;
      const out = await streamChat({
        key, model, messages: convo.current.slice(-24), signal: ctrl.signal,
        maxTokens: settings.current.maxTokens || 1200,
        onDelta: (d) => {
          if (first) { setThinking(null); first = false; }
          setLive((t) => (t ?? "") + d);
        },
      });
      convo.current.push({ role: "assistant", content: out.text });
      const toks = out.usage?.completion_tokens || 0;
      const tps = toks && out.seconds > 0 ? toks / out.seconds : null;
      const st = statsRef.current;
      st.turns += 1; st.tokens += toks; st.seconds += out.seconds;
      if (tps) st.tps.push(tps);
      push({
        kind: "assistant", text: out.text,
        meta: { model: out.resolvedModel, cost: out.charged != null ? `${fmtHero(out.charged)} $HERO` : "", secs: out.seconds.toFixed(1), tps },
      });
      if (out.charged) { setSpent((s) => s + out.charged); setBal((b) => (b == null ? b : Math.max(0, b - out.charged))); }
    } catch (e) {
      if (e.name === "AbortError") sys("cancelled", "Response cancelled. The partial answer is discarded.", false);
      else if (String(e.message).match(/balance|credit|insufficient|402|empty/i)) {
        const vk = await vaultBootKey().catch(() => null);
        const vBal = vk && vk !== key ? (await keyInfo(vk).catch(() => null))?.balance ?? null : null;
        if (vBal != null && vBal >= 2000) {
          setKey(vk); setBal(vBal);
          sys("vault", `That key is out of credits — switched to your wallet vault key (${fmtHero(vBal)} $HERO). Send that again.`);
        } else sys("inference error", e.message + `  ·  top up at ${BASE}/keys`, true);
      } else sys("inference error", e.message, true);
      convo.current.pop();
    } finally {
      setThinking(null); setLive(null); abortRef.current = null;
    }
  }, [key, model, toolsOn, agentId, push, sys]);

  // ---- commands ----
  const runCommand = useCallback(async (raw) => {
    const [cmd, ...args] = raw.trim().split(/\s+/);
    const arg = args.join(" ");
    const withSpin = async (note, fn) => {
      setThinking({ startedAt: Date.now(), note });
      try { return await fn(); }
      finally { setThinking(null); }
    };
    switch (cmd) {
      case "/help":
        sys("Hero Run terminal", [
          ...COMMANDS.map((c) => `${c.name.padEnd(10)} ${c.desc}`),
          "",
          "enter sends · esc cancels a response · ↑↓ input history",
          "chat is paid per call from your hr_live_ key, no subscription",
        ]);
        break;
      case "/stats": {
        const st = statsRef.current;
        const avg = st.seconds > 0 ? st.tokens / st.seconds : 0;
        sys("session", [
          `turns    ${st.turns}`,
          `tokens   ${st.tokens.toLocaleString()}`,
          `time     ${st.seconds.toFixed(1)}s in inference`,
          `speed    ${avg.toFixed(1)} tok/s avg   ${sparkline(st.tps)}`,
          `spend    ${fmtHero(spent)} $HERO this session`,
        ]);
        break;
      }
      case "/exit": exit(); setTimeout(() => process.exit(0), 30); break;
      case "/clear": convo.current = []; setItems([]); sys("cleared", "Conversation reset (the model forgets; your minted memories do not)."); break;
      case "/key": setSetup(true); break;
      case "/model": {
        if (arg) { setModel(arg); saveSettings({ model: arg }); sys("model", `Model set to ${arg}.`); break; }
        await withSpin("Fetching models", async () => {
          const ids = ["auto", ...(await listModels(key)).filter((m) => m !== "auto")];
          setOverlay({
            title: "Pick a model", filter: "", sel: 0,
            all: ids.map((m) => ({ label: m, value: m, hint: m === "auto" ? "routes per call" : "" })),
            onPick: (v) => { setModel(v); saveSettings({ model: v }); sys("model", `Model set to ${v}.`); },
          });
        }).catch((e) => sys("models", e.message, true));
        break;
      }
      case "/models":
        await withSpin("Fetching models", async () => {
          const ids = await listModels(key);
          const lines = [];
          let line = "";
          for (const id of ids) {
            if (line && (line + "  " + id).length > Math.max(40, cols - 8)) { lines.push(line); line = id; }
            else line = line ? line + "  " + id : id;
          }
          if (line) lines.push(line);
          sys(`${ids.length} models · /model to pick`, lines);
        }).catch((e) => sys("models", e.message, true));
        break;
      case "/balance":
        await withSpin("Checking balances", async () => {
          const info = await keyInfo(key).catch(() => null);
          const wal = await walletInfo().catch(() => null);
          sys("balance", [
            info ? `key      ${fmtHero(info.balance ?? info.remaining)} $HERO remaining${info.spent != null ? ` (${fmtHero(info.spent)} spent)` : ""}` : "key      unreadable",
            wal ? `wallet   ${wal.address}` : "wallet   none configured (HERO_AGENT_KEY_FILE)",
            wal ? `gas      ${wal.eth.toFixed(6)} ETH on Robinhood Chain (~${Math.floor(wal.eth / 0.000004)} memory writes)` : "",
            `session  ${fmtHero(spent)} $HERO spent`,
          ].filter(Boolean));
          if (info) setBal(info.balance ?? info.remaining ?? null);
        });
        break;
      case "/agents":
        await withSpin("Walking the contract", async () => {
          const wal = await walletInfo();
          if (!wal) return sys("agents", "No wallet key. Set HERO_AGENT_KEY_FILE or run: hero-agent wallet new", true);
          const list = await listAgents(wal.address);
          if (!list.length) return sys("agents", "This wallet owns no agents yet. Mint one: hero-agent wallet mint-agent");
          sys(`${list.length} agents on ${wal.address.slice(0, 8)}…`, list.map((a) => `#${String(a.id).padEnd(4)} ${(a.label || "unlabeled").padEnd(24)} ${a.count} checkpoints${a.id === Number(agentId) ? "   ← active" : ""}`));
        }).catch((e) => sys("agents", e.message, true));
        break;
      case "/agent": {
        const id = Number(arg);
        if (!Number.isFinite(id) || id < 1) { sys("agent", "Usage: /agent <id>", true); break; }
        setAgentId(id); saveSettings({ agentId: id });
        sys("agent", `Working agent is now #${id}. /recall reads it, /remember writes to it.`);
        break;
      }
      case "/recall":
        if (!agentId) { sys("recall", "Set an agent first: /agent <id>", true); break; }
        await withSpin("Reading the chain", async () => {
          const entries = await readMemory(agentId, { limit: Number(arg) || 15 });
          if (!entries.length) return sys(`agent #${agentId}`, "No memories yet.");
          sys(`agent #${agentId} · last ${entries.length}`, entries.map((e) => {
            const t = (e.text || "").replace(/\s+/g, " ");
            return `${(e.role || "?").padEnd(6)} ${t.length > 110 ? t.slice(0, 110) + "…" : t}`;
          }));
        }).catch((e) => sys("recall", e.message, true));
        break;
      case "/remember": {
        if (!agentId) { sys("remember", "Set an agent first: /agent <id>", true); break; }
        const lastQ = [...convo.current].reverse().find((m) => m.role === "user");
        const lastA = [...convo.current].reverse().find((m) => m.role === "assistant");
        const entries = arg
          ? [{ role: "user", text: "note::" + arg }]
          : lastQ && lastA
            ? [{ role: "user", text: lastQ.content }, { role: "agent", text: lastA.content }]
            : null;
        if (!entries) { sys("remember", "Nothing to save yet. Chat first, or /remember <note>.", true); break; }
        await withSpin("Minting to Robinhood Chain", async () => {
          const hash = await writeMemory(agentId, entries);
          sys("minted", [`${entries.length} entr${entries.length === 1 ? "y" : "ies"} sealed to agent #${agentId}.`, `tx ${hash}`]);
        }).catch((e) => sys("remember", e.message, true));
        break;
      }
      case "/channel": {
        const id = Number(arg || agentId);
        if (!Number.isFinite(id) || id < 1) { sys("channel", "Usage: /channel <agent id>", true); break; }
        await withSpin("Reading the channel", async () => {
          const { entries, membership } = await readChannel(id);
          const msgs = entries.filter((e) => e.text?.startsWith("msg::")).slice(-12).map((e) => {
            try { const m = JSON.parse(e.text.slice(5)); return `${e.room ? "🔒" : "·"} ${String(m.from).slice(0, 10)}  ${m.text.slice(0, 100)}`; } catch { return null; }
          }).filter(Boolean);
          sys(`channel #${id} · ${membership === "member" ? "group member 🔒" : membership === "foreign" ? "invited on another key" : "public view"}`,
            msgs.length ? msgs : ["No messages yet. /send " + id + " <text>"]);
        }).catch((e) => sys("channel", e.message, true));
        break;
      }
      case "/send": {
        const id = Number(args[0]);
        const text = args.slice(1).join(" ");
        if (!Number.isFinite(id) || !text) { sys("send", "Usage: /send <agent id> <message>", true); break; }
        await withSpin("Writing on-chain", async () => {
          const r = await sendChannel(id, text);
          sys("sent", [`Message written to channel #${id} as ${r.mode === "room" ? "a members-only room entry 🔒" : "a public entry"}.`, `tx ${r.hash}`]);
        }).catch((e) => sys("send", String(e.message).includes("not authorized") ? "The contract rejected the write. Ask the owner to approve your wallet." : e.message, true));
        break;
      }
      case "/learn": {
        if (rest[0] === "auto") {
          learnAutoRef.current = !learnAutoRef.current;
          sys("universe", learnAutoRef.current ? "Auto-learning ON: the Universe reviews every agent turn and mints what it teaches." : "Auto-learning off.");
          break;
        }
        const lt = lastTurnRef.current;
        if (!lt) { sys("universe", "Nothing to learn from yet — run an agent-mode turn first.", true); break; }
        if (!agentId) { sys("universe", "Pick a memory agent first: /agents then /agent <id>.", true); break; }
        await withSpin("The Universe reviews the attempt", async () => {
          const { lesson, cost } = await universeReview({ key, task: lt.task, trace: lt.trace, answer: lt.answer });
          if (cost) { setSpent((s) => s + cost); setBal((b) => (b == null ? b : Math.max(0, b - cost))); }
          if (!lesson) { sys("universe", "No durable lesson in that turn. The Hero did fine."); return; }
          // YOU are the acceptance gate here: the lesson only mints if you judge it worth keeping.
          const ok = await new Promise((resolveA) => setPendingTool({ name: "mint lesson", args: { lesson }, resolve: resolveA }));
          if (!ok) { sys("universe", "Lesson rejected at your gate. Nothing touched the chain."); return; }
          const hash = await mintLesson(agentId, lesson);
          lessonsRef.current.list.push(lesson);
          sys("universe", [`Lesson minted to agent #${agentId}:`, `  ${lesson}`, `tx ${hash.slice(0, 14)}… · the Hero starts every future session knowing this.`]);
        }).catch((e) => sys("universe", e.message, true));
        break;
      }
      case "/auto": {
        autoRef.current = !autoRef.current;
        sys("auto", autoRef.current
          ? "Auto mode ON: every tool runs without asking, shell included. /auto again to turn it off."
          : "Auto mode OFF: shell and write_file ask again.");
        break;
      }
      case "/turbo": {
        // Picker of everything Cerebras serves, pinned @cerebras. First row restores the previous
        // model when turbo is already on.
        await withSpin("Fetching Cerebras models", async () => {
          const ms = await cerebrasModels();
          if (!ms.length) { sys("turbo", "The catalog lists no Cerebras-served models right now.", true); return; }
          const onTurbo = model.endsWith("@cerebras");
          setOverlay({
            title: "Turbo — Cerebras wafer speed", filter: "", sel: 0,
            all: [
              ...(onTurbo ? [{ label: "turbo off", value: "__off", hint: `back to ${preTurboRef.current || "auto"}` }] : []),
              ...ms.map((m) => ({ label: `${m.id}@cerebras`, value: `${m.id}@cerebras`, hint: `⬡ ${Math.round(m.hero).toLocaleString()}` })),
            ],
            onPick: (v) => {
              if (v === "__off") {
                const backTo = preTurboRef.current || "auto";
                setModel(backTo); saveSettings({ model: backTo });
                sys("turbo", `Turbo off. Back to ${backTo}.`);
                return;
              }
              if (!model.endsWith("@cerebras")) preTurboRef.current = model;
              setModel(v); saveSettings({ model: v });
              sys("turbo", `Turbo ON: ${v} (~sub-second first token). /turbo → "turbo off" to restore.`);
            },
          });
        }).catch((e) => sys("turbo", e.message, true));
        break;
      }
      case "/tools": {
        setToolsOn((t) => !t);
        sys("tools", toolsOn ? "Agent mode OFF. Plain streamed chat, no tools." : "Agent mode ON. shell and write_file ask before running; reads and web search are automatic.");
        break;
      }
      case "/vault": {
        const sub = args[0];
        const V = await vaultOps();
        const mask = (v) => (v.length <= 8 ? "••••" : v.slice(0, 4) + "…" + v.slice(-2));
        try {
          if (sub === "ls" || !sub) {
            const names = await V.listSecrets();
            sys("vault", names.length ? names : ["(empty — /vault set NAME=value)"]);
          } else if (sub === "set") {
            const pairs = args.slice(1).filter((p) => p.includes("="));
            if (!pairs.length) { sys("vault", "Usage: /vault set NAME=value [NAME2=value2]", true); break; }
            for (const p of pairs) { const i = p.indexOf("="); await V.setSecret(p.slice(0, i), p.slice(i + 1)); }
            sys("vault", pairs.map((p) => `✓ ${p.slice(0, p.indexOf("="))} sealed to the wallet vault`));
          } else if (sub === "get") {
            if (!args[1]) { sys("vault", "Usage: /vault get NAME", true); break; }
            const env = await V.secrets({ purpose: `hero TUI /vault get ${args[1]}` });
            if (!(args[1] in env)) { sys("vault", `${args[1]} is not in the vault.`, true); break; }
            sys("vault", [`${args[1]} = ${env[args[1]]}`, "(shown in scrollback — /clear when done)"]);
          } else if (sub === "rm") {
            if (!args[1]) { sys("vault", "Usage: /vault rm NAME", true); break; }
            await V.deleteSecret(args[1]);
            sys("vault", `✓ removed ${args[1]}`);
          } else if (sub === "login") {
            if (!args[1]) { sys("vault", ["Usage: /vault login <hvt1.… token>", `Mint one at ${BASE}/locker → Environment → Connect a machine.`], true); break; }
            const { address } = await V.vaultLogin({ token: args[1] });
            sys("vault", [`✓ machine logged in for ${mask(address)}`, "This token decrypts your vault. It cannot sign, spend, or mint."]);
          } else sys("vault", "Subcommands: ls · set NAME=value · get NAME · rm NAME · login <token>", true);
        } catch (e) { sys("vault", e.message, true); }
        break;
      }
      default: sys(cmd, "Unknown command. /help lists everything.", true);
    }
  }, [key, model, agentId, spent, exit, sys, push]);

  // ---- input handling ----
  useInput((ch, k) => {
    // approval gate owns the keyboard while a tool waits: y = once, a = always this session, n/esc = no
    if (pendingTool) {
      const c = (ch || "").toLowerCase();
      if (c === "y" || k.return) { pendingTool.resolve(true); setPendingTool(null); }
      else if (c === "a") { alwaysRef.current.add(pendingTool.name); pendingTool.resolve(true); setPendingTool(null); }
      else if (c === "n" || k.escape) { pendingTool.resolve(false); setPendingTool(null); }
      return;
    }
    // overlay picker owns the keyboard while open
    if (overlay) {
      const filtered = overlay.all.filter((it) => it.label.toLowerCase().includes(overlay.filter.toLowerCase()));
      if (k.escape) return setOverlay(null);
      if (k.return) { const pick = filtered[overlay.sel]; setOverlay(null); if (pick) overlay.onPick(pick.value); return; }
      if (k.upArrow) return setOverlay({ ...overlay, sel: Math.max(0, overlay.sel - 1) });
      if (k.downArrow) return setOverlay({ ...overlay, sel: Math.min(Math.min(filtered.length, 9) - 1, overlay.sel + 1) });
      if (k.backspace || k.delete) return setOverlay({ ...overlay, filter: overlay.filter.slice(0, -1), sel: 0 });
      if (ch && !k.ctrl && !k.meta) return setOverlay({ ...overlay, filter: overlay.filter + ch, sel: 0 });
      return;
    }
    if (k.escape) {
      if (abortRef.current) abortRef.current.abort();
      return;
    }
    if (thinking || live != null) return; // busy: only esc is live
    if (slashOpen && slashItems.length) {
      if (k.upArrow) return setSlashSel((s) => Math.max(0, s - 1));
      if (k.downArrow) return setSlashSel((s) => Math.min(slashItems.length - 1, s + 1));
      if (k.tab) { const c = slashItems[slashSel]; setInput(c.name + " "); setCursor(c.name.length + 1); return; }
    }
    if (k.return) {
      const value = (slashOpen && slashItems.length && input.trim() !== slashItems[slashSel].name ? slashItems[slashSel].name : input).trim();
      if (!value) return;
      setInput(""); setCursor(0);
      if (setup) { submitSetup(value); return; } // never recorded in input history
      const h = histRef.current;
      h.list.push(value); h.idx = -1; h.draft = "";
      if (value.startsWith("/")) runCommand(value);
      else ask(value);
      return;
    }
    if (k.upArrow || k.downArrow) {
      const h = histRef.current;
      if (!h.list.length) return;
      if (k.upArrow) {
        if (h.idx === -1) { h.draft = input; h.idx = h.list.length - 1; }
        else h.idx = Math.max(0, h.idx - 1);
      } else {
        if (h.idx === -1) return;
        h.idx = h.idx + 1 > h.list.length - 1 ? -1 : h.idx + 1;
      }
      const v = h.idx === -1 ? h.draft : h.list[h.idx];
      setInput(v); setCursor(v.length);
      return;
    }
    if (k.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (k.rightArrow) return setCursor((c) => Math.min(input.length, c + 1));
    if (k.ctrl && ch === "a") return setCursor(0);
    if (k.ctrl && ch === "e") return setCursor(input.length);
    if (k.ctrl && ch === "u") { setInput(""); setCursor(0); return; }
    if (k.backspace || k.delete) {
      if (cursor === 0) return;
      setInput((v) => v.slice(0, cursor - 1) + v.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }
    if (ch && !k.ctrl && !k.meta) {
      // Pasted chunks arrive as one string with newlines INSIDE them, not as key.return events
      // ("/help\r" pastes the slash-command plus a carriage return in a single input event).
      // Split on the first newline: everything before it lands in the buffer, and the newline
      // submits, exactly as if the user had typed then pressed enter.
      const nl = ch.search(/[\r\n]/);
      if (nl >= 0) {
        const before = ch.slice(0, nl);
        const value = (input.slice(0, cursor) + before + input.slice(cursor)).trim();
        setInput(""); setCursor(0);
        if (!value) return;
        if (setup) { submitSetup(value); return; }
        const h = histRef.current;
        h.list.push(value); h.idx = -1; h.draft = "";
        if (value.startsWith("/")) runCommand(value);
        else ask(value);
        return;
      }
      const clean = ch.replace(/[\x00-\x1f]/g, "");
      if (!clean) return;
      setInput((v) => v.slice(0, cursor) + clean + v.slice(cursor));
      setCursor((c) => c + clean.length);
    }
  });

  // first-run wizard: validate the pasted key against the network before saving it
  const submitSetup = useCallback(async (candidate) => {
    candidate = candidate.trim();
    if (!candidate.startsWith("hr_")) { sys("key", "That does not look like an hr_live_ key. Mint one at " + BASE + "/keys", true); return; }
    setThinking({ startedAt: Date.now(), note: "Checking the key" });
    try {
      const info = await keyInfo(candidate);
      const path = saveKey(candidate);
      setKey(candidate); setSetup(false);
      setBal(info.balance ?? info.remaining ?? null);
      sys("welcome", [
        `Key saved to ${path} (0600).`,
        `${fmtHero(info.balance ?? info.remaining)} $HERO ready. Every reply is paid per call, no subscription.`,
        "Say something, or /help.",
      ]);
    } catch (e) { sys("key", e.message, true); }
    finally { setThinking(null); }
  }, [sys]);

  // ---- render ----
  const bannerInHistory = items.length > 0;
  const filteredOverlay = overlay ? overlay.all.filter((it) => it.label.toLowerCase().includes(overlay.filter.toLowerCase())) : [];

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(it) => {
          if (it.kind === "user") return <UserLine key={it.id} text={it.text} />;
          if (it.kind === "assistant") return <AssistantBlock key={it.id} text={it.text} meta={it.meta} />;
          return <SysBlock key={it.id} title={it.title} lines={it.lines} error={it.error} />;
        }}
      </Static>

      {!bannerInHistory && <Banner animated version={version} />}
      {!bannerInHistory && !setup && (
        <Box flexDirection="column" borderStyle="round" borderColor={MINERAL} paddingX={1} marginBottom={1}>
          <Text><Chip>HERO</Chip><Text color={PAPER}> Chat is paid in $HERO per call and funds one frontier open training run.</Text></Text>
          <Text color={STONE}>  /help commands · /model pick a brain · /agents your on-chain memory</Text>
        </Box>
      )}
      {setup && (
        <Box flexDirection="column" borderStyle="round" borderColor={BRASS} paddingX={1} marginBottom={1}>
          <Text bold color={BRASS}>Connect your inference key</Text>
          <Text color={PAPER}>Paste an hr_live_ key and press enter. Mint one at {BASE}/keys.</Text>
          <Text color={STONE}>Saved to ~/.hero-agent/hero-run-key.txt, permissions 0600, never sent anywhere but herorunai.com.</Text>
        </Box>
      )}

      {live != null && live !== "" && (
        <Box marginTop={1}>
          <Text color={MINERAL}>✻ </Text>
          <Box flexDirection="column" flexGrow={1}><Md text={live} /></Box>
        </Box>
      )}
      {thinking && <Box marginTop={1}><Thinking startedAt={thinking.startedAt} note={thinking.note} /></Box>}

      {overlay && <Picker title={overlay.title} items={filteredOverlay} filter={overlay.filter} sel={overlay.sel} />}

      {pendingTool && (
        <Box borderStyle="round" borderColor={BRASS} paddingX={1} marginTop={1} flexDirection="column">
          <Text bold color={BRASS}>{pendingTool.name} wants to run</Text>
          <Text color={PAPER} wrap="truncate-end">  {pendingTool.name === "shell" ? String(pendingTool.args.cmd || "") : pendingTool.args.lesson ? String(pendingTool.args.lesson) : JSON.stringify(pendingTool.args).slice(0, 200)}</Text>
          <Text color={STONE}>  (y)es once · (a)lways this session · (n)o</Text>
        </Box>
      )}
      {!overlay && (
        <Box borderStyle="round" borderColor={thinking ? BRASS : STONE} paddingX={1} marginTop={1}>
          <Text color={BRASS}>{setup ? "key ›" : "›"} </Text>
          <Text wrap="truncate-start">
            {/* the key is masked while typing: terminals get screenshotted and screens get shared */}
            {(setup ? "•".repeat(Math.max(0, cursor)) : input.slice(0, cursor))}
            <Text inverse>{(setup ? (input[cursor] ? "•" : " ") : input[cursor] || " ")}</Text>
            {(setup ? "•".repeat(Math.max(0, input.length - cursor - 1)) : input.slice(cursor + 1))}
          </Text>
        </Box>
      )}
      {slashOpen && slashItems.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {slashItems.slice(0, 8).map((c, i) => (
            <Text key={c.name} color={i === slashSel ? BRASS : STONE} inverse={i === slashSel}>
              {` ${c.name.padEnd(10)} `}<Text color={i === slashSel ? undefined : STONE}>{c.desc}</Text>
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={STONE}>
          {model}
          {bal != null ? ` · ⬡ ${fmtHero(bal)} $HERO` : ""}
          {agentId ? ` · agent #${agentId}` : ""}
          {spent > 0 ? ` · session ${fmtHero(spent)}` : ""}
          {toolsOn ? (autoRef.current ? " · tools(auto)" : " · tools") : ""}
          {hasWallet() ? "" : " · no wallet (memory off)"}
          {cols >= 90 ? " · enter send · esc cancel · /help" : ""}
        </Text>
      </Box>
    </Box>
  );
}
