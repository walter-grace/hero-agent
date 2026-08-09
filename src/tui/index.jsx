// Entry for the `hero` terminal app.
//   hero            interactive session
//   hero --smoke    render one frame and exit 0 (CI / packaging sanity check)
//   hero --version  print the version
import React from "react";
import { render } from "ink";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import App from "./app.jsx";
import { Banner } from "./ui.jsx";

const here = dirname(fileURLToPath(import.meta.url));
let version = "";
for (const p of [join(here, "../../package.json"), join(here, "../package.json")]) {
  try { version = JSON.parse(readFileSync(p, "utf8")).version; break; } catch {}
}

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(`hero ${version}`);
  process.exit(0);
}
if (argv.includes("--smoke")) {
  const { unmount } = render(<Banner animated={false} version={version} />);
  setTimeout(() => { unmount(); process.exit(0); }, 200);
} else {
  render(<App version={version} />, { exitOnCtrlC: true });
}
