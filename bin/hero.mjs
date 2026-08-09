#!/usr/bin/env node
// The Hero Run terminal. Ships prebuilt (dist/tui.mjs); source lives in src/tui/.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "tui.mjs");
if (!existsSync(dist)) {
  console.error("dist/tui.mjs is missing. Build it once:  npm run build:tui");
  process.exit(1);
}
await import(dist);
