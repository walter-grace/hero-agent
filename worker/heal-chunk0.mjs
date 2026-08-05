// One-off heal: chunk 0's swap landed (tx 0xc6a6668e…, +122,885 HERO to the recipient) but its
// twaprun:: record failed to write when the public RPC rate-limited that first tick. Without the
// record, once the claim TTL expires the cron would re-buy chunk 0. This appends the missing
// twaprun:: so chunk 0 is marked done and the plan advances cleanly to chunk 1.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

let pk = readFileSync(`${homedir()}/.hero-agent/keys/0x66e07BDa43afEc9360A1c4B1CFd5D61564F50ceA.key`, "utf8").trim();
if (!pk.startsWith("0x")) pk = "0x" + pk;
const { OnchainMemory } = await import(pathToFileURL(`${homedir()}/Desktop/hero-agent/src/memory/onchain.mjs`));
const mem = new OnchainMemory({ agentId: 10, privateKey: pk });

const entries = await mem.raw();
const { parseTwapPlans } = await import(pathToFileURL(`${homedir()}/Desktop/hero-agent/worker/twap.mjs`));
const { plans, runs } = parseTwapPlans(entries);
const plan = [...plans.values()][0];
if (!plan) { console.log("no plan found on agent #10"); process.exit(1); }
if (runs.some((r) => r.planId === plan.planId && r.i === 0 && r.ok)) { console.log("chunk 0 already recorded — nothing to heal."); process.exit(0); }

const rec = { planId: plan.planId, i: 0, ok: true, tx: "0xc6a6668e7f73372c084baeb807ba71d334656f2669dc4114dbc866a7deead481", amountOut: "122885891000000000000000", at: new Date().toISOString(), healed: true };
await mem.append([{ role: "system", text: "twaprun::" + JSON.stringify(rec) }]);
console.log(`✓ healed: chunk 0 marked done for plan ${plan.planId}. The cron will now run chunk 1 when due.`);
