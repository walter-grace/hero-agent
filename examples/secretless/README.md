# The secretless bot

A working agent with **no `.env` file and no keys anywhere in the code or repo**. Its secrets live in
a wallet-encrypted vault; the only thing on the machine is a token that can decrypt and do nothing
else.

```bash
node bot.mjs
```

```
vault → injected 1 secret(s): HERO_RUN_KEY
key hr_live_eb30… → balance ⬡ 52,267

model says: Because a wallet-encrypted vault stores keys in cryptographically sealed
storage that never exposes plaintext on disk, whereas a .env file leaves decrypted
secrets sitting in clear-text on the filesystem…
```

## What just happened

1. `loadHeroEnv()` read `~/.hero-agent/vault-token.json`, fetched the vault ciphertext from
   herorunai.com, decrypted it locally, and injected `HERO_RUN_KEY` into `process.env`.
2. The bot authenticated with that key and asked a model a question through Hero Run's `/v1`.
3. The pull was appended to the access log you can read at [herorunai.com/locker](https://herorunai.com/locker).

## Set it up yourself (two commands)

```bash
# once per machine — EITHER from a key file (used once)…
hero-agent vault login --key-file ~/.hero-agent/my.key
# …OR paste a token minted in the web UI (herorunai.com/locker → Environment → Connect a machine),
# so this machine never sees a private key at all:
hero-agent vault login --token hvt1.0xYourAddr.0x…

# put your secrets in (any NAME=value; manage them on /locker too)
hero-agent vault set HERO_RUN_KEY=hr_live_… OPENAI_API_KEY=sk-…
```

Then either load in code (`await loadHeroEnv()`) or wrap any process:

```bash
hero-agent vault run -- node bot.mjs
hero-agent vault run -- python train.py
```

## Two ways to leverage it

`bot.mjs` loads the vault IN code (`loadHeroEnv()`). `brief.mjs` is the other path: an ordinary
script that reads `process.env` and has no idea the vault exists — wrap it and secrets arrive at
spawn:

```bash
hero-agent vault run -- node brief.mjs
```

```
── morning brief ──
Catalog holds 646 models; newest arrival is Dots3-Note Preview (free).
Treasury claimable: 934,499,443 HERO.
```

Your existing bots, cron jobs, and Python scripts work unmodified. The wrapper is the migration.

## Why this beats a .env file

The token in `vault-token.json` can decrypt the vault. That is the complete list of its powers: it
cannot sign transactions, spend, or mint. So a stolen laptop or a compromised CI runner leaks
secrets you can rotate in one place, never the wallet you can't. And every read is logged, so "what
pulled my secrets, and when" has an answer instead of a shrug.
