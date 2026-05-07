# Scribe — Claude Code instructions

Scribe is the **Discord ↔ GitHub bridge** for the Chronoforge WoW addon suite (`gezmodean-wow/{cogworks,tally,flipqueue,tempo,maxcraft}`). Mirrors player reports → GitHub issues, comments → Discord threads, drafts release announcements per cog.

For service-side details (architecture, deployment, modules), see `README.md` and `docs/`.

## Standards acknowledgments

Each session, check the top entry of each source against the codes below. If newer, prefix the first response with `Standards updated:` plus a one-line summary per new entry, then update the code below as part of the session's commit.

| Source | Last acknowledged |
|---|---|
| [comms conventions](https://github.com/gezmodean-wow/cogworks/blob/main/runbooks/comms-conventions.md) | 2026-05-05a |
| [branch & release flow](https://github.com/gezmodean-wow/cogworks/blob/main/runbooks/branch-and-release-flow.md) | 2026-05-06a |
| [doc conventions](https://github.com/gezmodean-wow/cogworks/blob/main/runbooks/doc-conventions.md) | 2026-05-05a |
| [technical standards](https://github.com/gezmodean-wow/cogworks/blob/main/runbooks/technical-standards.md) | 2026-05-05a |
| [standards-sync mechanism](https://github.com/gezmodean-wow/cogworks/blob/main/runbooks/standards-sync.md) | 2026-05-05a |

Scribe does NOT subscribe to the `cogworks/shared/` file pool — that pool is WoW-cog-specific (PR/issue templates assume in-game `/cog debug` Copy diagnostics; pre-tag-check.sh assumes BigWigsMods packager). Scribe maintains its own PR/issue templates and release process appropriate to a Railway-deployed Node service.

## Scope of standards adoption

Scribe is a TypeScript / Node service deployed to Railway. Some cogworks runbook rules apply directly; some don't:

**Apply:**
- Comments + readability (technical-standards rule 1) — TypeScript code documented for outside contribution.
- License compliance (rule 2) — npm deps, GitHub Actions, etc.
- Smaller files (rule 3) — modules under `src/modules/` follow this; new modules use the same pattern.
- Agent handoff (rule 4) — every active issue gets status comments; in-flight context preserved across sessions.
- Backwards compatibility (rule 5) — Postgres schemas, thread↔issue mappings, public webhook contracts.
- Observability (subset of rule 6) — `pino` is the canonical logger; errors flow through it with enough context to triage. The "no silent failures" sub-rule applies; the "in-game debug console" sub-rules don't.
- Naming + namespace hygiene (rule 7) — TypeScript naming conventions; no leaking globals.
- Performance discipline (rule 8) — webhook latency budgets matter for Discord/GitHub responsiveness.

**Don't apply (WoW-specific):**
- In-game debug surface (rule 6.1–6.6) — no client-side UI.
- Localization (rule 9) — scribe doesn't render player-facing UI text; player content is relayed verbatim.
- Saved-variable size discipline (rule 10) — Postgres handles state, not WoW SVs.
- TOC interface-version policy (rule 11).
- Cogworks-driven UI primitives (rule 12).

## Comms conventions are critical

Scribe is the **consumer** of the comms conventions defined in `cogworks/runbooks/comms-conventions.md`. The parser code in `src/modules/tickets/release-notes.ts` (and elsewhere) implements the rules in that runbook.

When the comms-conventions runbook adds a Standards changelog entry that affects parser behavior, coordinate the change:
1. Update the parser to match the new rule.
2. Append a corresponding entry to the comms-conventions runbook's Standards changelog cross-referencing the scribe PR.
3. Both versions stay in step.

`docs/PLAYER_FACING_CONVENTIONS.md` is **historical**. The canonical home is `cogworks/runbooks/comms-conventions.md`. The historical doc is retained for now as a redirect note; do not update it with new content. Coordinated migration to a pure-redirect or archival state is tracked as a follow-up ticket.

## Release process

Scribe deploys to Railway on push to `main` — there is no tag-triggered upload like the WoW cogs have. Optional version tags can be cut for human-readable tracking; they don't gate deployment.

When tagging:
- Follow `branch-and-release-flow.md` for branching and PR discipline.
- Skip the alpha/beta/release channel split — backend services don't have an opt-in player cohort. Tag as `vX.Y.Z` directly.
- The pre-tag-check.sh from the cog file pool doesn't apply (no `.pkgmeta`, no RELEASES.md in the WoW-cog format). Scribe's CI checks (build, lint, type-check) cover the equivalent ground.

## Modeling the release process with ticket status

This is in-flight work — see open issue(s) tagged `release-state-modeling`. The chronoforge release model (alpha = exposure not WIP; promotion by re-tagging same commit; beta optional release candidate) requires scribe to track per-issue release-channel state and distinguish "newly fixed" from "promoted to stable" in announcements. Until that work lands, scribe's release-announcement behavior treats every tag's closed-issue rollup as "newly fixed."
