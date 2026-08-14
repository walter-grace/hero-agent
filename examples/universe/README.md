# The Hero/Universe school

A teacher-student loop where the knowledge lives on-chain. The **Hero** is a small, fast, cheap
model doing real work with tools. The **Universe** is a frontier model that reviews each attempt and
distills one durable lesson. Lessons mint to the agent's memory on Robinhood Chain, and every future
session injects them into the student's prompt. The small model stays small. The wallet gets smarter.

```bash
HERO_AGENT_KEY_FILE=~/.hero-agent/keys/<wallet>.key node school.mjs
```

Real output from a live run (fresh agent, minted at the start of class):

```
ROUND 1 — no lessons. gemma-4-31b@cerebras attempts: "what are the largest files in my home folder?"
  [3s]   · shell(find ~ -type f -exec du -h {} + | sort -rh …)     ← the classic mistake
  [34s]  · shell(find ~ -type f -size +100M …)
  … 6 tool steps, flailing …
  round 1: 6 tool step(s) · 158s · 41857 $HERO

CLASS — the Universe reviews the attempt…
  the Universe teaches: "When answering, verify that your command searches the exact directory
  requested and that the displayed results reflect the full scope before responding."
  minted on-chain to agent #45 · tx 0xdc71437042a6cb4b…

ROUND 2 — same task, fresh conversation, lessons loaded from chain.
  1 lesson(s) recalled from Robinhood Chain
  round 2: 3 tool step(s) · 71s · 23518 $HERO

═══ SCOREBOARD ═══
  round 1 (no lessons):   6 steps · 158s · 41857 $HERO
  round 2 (after school): 3 steps · 71s · 23518 $HERO
  tuition (Universe review): 2675 $HERO, paid once — the lesson is on-chain forever.
```

Half the steps, half the time, 44% cheaper, from one lesson.

## Honest notes

- The improvement has two sources: the minted lesson AND the shell tool's teaching timeouts (a
  killed command explains what to do instead). Both are deliberate; the lesson is the part that
  persists across sessions and models.
- Run it again with the same agent (`node school.mjs 45`) and the curriculum compounds: each run
  can add a lesson, and round 1 of the next run starts where round 2 left off.
- In the `hero` TUI this is `/learn` (review the last turn) and `/learn auto` (the Universe attends
  every turn). Lessons load automatically: "N earned lesson(s) loaded from agent #…".
- Because lessons are ordinary on-chain memory, selling the agent sells its education.
