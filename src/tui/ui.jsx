// Presentational pieces: animated banner, thinking spinner, markdown text, boxes.
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { gradient, BRASS, MINERAL, STEEL, STONE, EMBER, PAPER } from "./theme.mjs";

export const LOGO = [
  "█ █ █▀▀ █▀█ █▀█   █▀█ █ █ █▄ █",
  "█▀█ ██▄ █▀▄ █▄█   █▀▄ █▄█ █ ▀█",
];

// Shimmering wordmark. `animated` drives a phase sweep; frozen it renders one gradient pass,
// which is what the banner becomes once it scrolls into history.
export function Banner({ animated = true, version = "" }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!animated) return;
    const t = setInterval(() => setPhase((p) => (p + 0.04) % 2), 90);
    return () => clearInterval(t);
  }, [animated]);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {LOGO.map((line, i) => (
        <Text key={i}>
          {gradient(line, phase + i * 0.12).map((s, j) => (
            <Text key={j} color={s.color}>{s.ch}</Text>
          ))}
        </Text>
      ))}
      <Text color={STONE}>
        fund open-source AI by using it · herorunai.com{version ? <Text color={STONE}> · v{version}</Text> : null}
      </Text>
    </Box>
  );
}

const FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const VERBS = ["Routing", "Reasoning", "Composing", "Distilling", "Forging", "Weighing", "Polishing"];

// Claude Code-style thinking line: pulsing glyph, cycling verb, live elapsed seconds, cancel hint.
export function Thinking({ startedAt, note }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 90); return () => clearInterval(t); }, []);
  const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
  const verb = note || VERBS[Math.floor(tick / 26) % VERBS.length];
  return (
    <Box>
      <Text color={BRASS}>{FRAMES[tick % FRAMES.length]} </Text>
      <Text color={PAPER}>{verb}… </Text>
      <Text color={STONE}>({secs}s · esc to cancel)</Text>
    </Box>
  );
}

// ---- minimal terminal markdown ----
// Line-based: fenced code blocks, headers, bullets; inline **bold** and `code`. Enough to make
// model output readable without pulling in a renderer dependency.
function inline(text, keyBase) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <Text key={`${keyBase}-${i}`} bold color={PAPER}>{p.slice(2, -2)}</Text>;
    if (p.startsWith("`") && p.endsWith("`")) return <Text key={`${keyBase}-${i}`} color={BRASS}>{p.slice(1, -1)}</Text>;
    return <Text key={`${keyBase}-${i}`}>{p}</Text>;
  });
}

export function Md({ text }) {
  const lines = String(text || "").split("\n");
  const out = [];
  let inCode = false, codeLines = [], codeLang = "";
  const flushCode = (key) => {
    out.push(
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={STONE} paddingX={1} marginY={0}>
        {codeLang ? <Text color={STONE}>{codeLang}</Text> : null}
        {codeLines.map((c, i) => <Text key={i} color={STEEL}>{c || " "}</Text>)}
      </Box>
    );
    codeLines = []; codeLang = "";
  };
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("```")) {
      if (inCode) flushCode(`code-${i}`);
      else codeLang = line.trim().slice(3);
      inCode = !inCode;
      return;
    }
    if (inCode) { codeLines.push(line); return; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(<Text key={i} bold color={MINERAL}>{h[2]}</Text>); return; }
    const b = line.match(/^(\s*)[-*]\s+(.*)/);
    if (b) { out.push(<Text key={i}>{b[1]}<Text color={BRASS}>• </Text>{inline(b[2], i)}</Text>); return; }
    const n = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (n) { out.push(<Text key={i}>{n[1]}<Text color={BRASS}>{n[2]}. </Text>{inline(n[3], i)}</Text>); return; }
    out.push(<Text key={i}>{line ? inline(line, i) : " "}</Text>);
  });
  if (inCode && codeLines.length) flushCode("code-tail");
  return <Box flexDirection="column">{out}</Box>;
}

// A completed exchange, rendered into scrollback.
export function UserLine({ text }) {
  return (
    <Box marginTop={1}>
      <Text color={STONE}>{"> "}</Text>
      <Text color={PAPER}>{text}</Text>
    </Box>
  );
}

export function AssistantBlock({ text, meta }) {
  // tok/s graded like a speedometer (mac-code's trick): green when brisk, amber when slow,
  // ember when crawling — one glance says whether the routed model is pulling its weight.
  const tpsColor = meta?.tps == null ? STONE : meta.tps > 40 ? "#7fbf7f" : meta.tps > 12 ? BRASS : EMBER;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={MINERAL}>✻ </Text>
        <Box flexDirection="column" flexGrow={1}><Md text={text} /></Box>
      </Box>
      {meta ? (
        <Text color={STONE}>
          {"  "}{meta.model}
          {meta.cost ? ` · ${meta.cost}` : ""}
          {` · ${meta.secs}s`}
          {meta.tps != null ? <Text color={tpsColor}> · {meta.tps.toFixed(0)} tok/s</Text> : null}
        </Text>
      ) : null}
    </Box>
  );
}

// Inverted brand chip, the " HERO " badge: bold ink on brass.
export function Chip({ children }) {
  return <Text bold backgroundColor={BRASS} color="#1a1712"> {children} </Text>;
}

export function SysBlock({ title, lines, error }) {
  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={EMBER} paddingX={1} marginTop={1}>
        {title ? <Text bold color={EMBER}>✗ {title}</Text> : null}
        {(lines || []).map((l, i) => (typeof l === "string" ? <Text key={i} color={PAPER}>{l}</Text> : <React.Fragment key={i}>{l}</React.Fragment>))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {title ? <Text bold color={STEEL}>◆ {title}</Text> : null}
      {(lines || []).map((l, i) => (
        <Box key={i} paddingLeft={2}>{typeof l === "string" ? <Text color={PAPER}>{l}</Text> : l}</Box>
      ))}
    </Box>
  );
}

// Generic overlay picker: filter as you type, arrows move, enter picks, esc closes.
export function Picker({ title, items, filter, sel }) {
  const shown = items.slice(0, 9);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BRASS} paddingX={1}>
      <Text bold color={BRASS}>{title}</Text>
      <Text color={STONE}>{filter ? `filter: ${filter}` : "type to filter · ↑↓ · enter · esc"}</Text>
      {shown.map((it, i) => (
        <Text key={it.value ?? it.label} color={i === sel ? BRASS : PAPER} inverse={i === sel}>
          {` ${it.label} `}{it.hint ? <Text color={i === sel ? undefined : STONE}> {it.hint}</Text> : null}
        </Text>
      ))}
      {items.length > 9 ? <Text color={STONE}>… {items.length - 9} more, keep typing</Text> : null}
    </Box>
  );
}
