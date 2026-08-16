# SCRIBE

**S**ynchronized **C**ogwork **R**epository & **I**ssue **B**ureau **E**ngine.

The Chronoforge's ledger-clerk. SCRIBE listens to the forum halls, catches every report and half-remembered grievance a player mumbles into the guild book, and — with a bit of chronomantic filing — matches it against the open ledger. Worthy entries are inscribed into the cog repositories as issues, shepherded through their lifecycle, and announced to the faithful when they are resolved. Players never need leave the Discord to follow their issue's fate.

## What SCRIBE does

- Watches Chronoforge forum channels for player feedback.
- Runs similarity checks against open issues and proposes merges for developer approval (never auto-merges).
- On acknowledgement, files the thread as a GitHub Issue in the matching cog repo (FlipQueue, Tempo, Maxcraft, Cogworks, and friends).
- Mirrors comments both ways: thread ↔ issue.
- Recognizes Claude Code status comments (e.g. `@needs-info:`) and routes them to the thread; ferries player replies back to the issue.
- On release, drafts a human-facing changelog from closed issues per cog and posts to `#releases` — channel-aware (alpha / beta / release) and promotion-aware, so re-tagging an alpha as stable announces as "promoted to stable" rather than re-announcing the same fixes as new. See [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md).
- `/release-check <cog>` reports pre-tag readiness: pending issues, missing `## Player summary` sections, RELEASES.md section status, and whether the tag would be a promotion.
- Notifies subscribed players when issues they care about change state.

## What SCRIBE is not

- Not a code worker. Claude Code does the engineering; SCRIBE moves metadata and words.
- Not a replacement for the cog repos. GitHub Issues remain the canonical ticket store; SCRIBE is a bridge, not a backend.

## Stack

- Node 22+, TypeScript (ESM).
- `discord.js` v14 for the gateway bot.
- `fastify` for GitHub webhooks and the (eventual) admin UI.
- `pino` for logs, `zod` for config validation.
- Postgres will land when the tickets module needs persistence (thread↔issue map, subscriptions).

## Running locally

```sh
npm install
cp .env.example .env
# fill in DISCORD_BOT_TOKEN, DISCORD_APP_ID, GITHUB_APP_*, GITHUB_WEBHOOK_SECRET
npm run dev
```

Deployed on Railway. One service, one Postgres, one Discord identity.

## Repo layout

```
scribe/
├── src/
│   ├── index.ts            # entrypoint: wires config, logger, discord, http
│   └── core/               # cross-cutting infra — used by every module
│       ├── config.ts       # env loading + validation
│       ├── logger.ts       # pino
│       ├── discord.ts      # discord.js client factory
│       └── http.ts         # fastify server factory
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

Features will live under `src/modules/` as they're added — starting with `modules/tickets/` for the core feedback ↔ GitHub loop.
