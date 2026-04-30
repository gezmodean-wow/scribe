# Player-facing conventions

**Canonical source.** Each cog repo's `CLAUDE.md` should fetch this file at the start of any session involving releases, closing issues, or writing GitHub comments meant to reach players. Don't restate these rules in cog docs — link here so updates stay in one place.

The file lives in the private `gezmodean-wow/scribe` repo. Cog sessions fetch it via:

```sh
gh api -H "Accept: application/vnd.github.raw" \
  repos/gezmodean-wow/scribe/contents/docs/PLAYER_FACING_CONVENTIONS.md
```

## Changelog

Cog `CLAUDE.md` files should track the most recent entry they've acknowledged. If the top entry below is newer than the cog's `Last acknowledged` date, the session must prefix its first response with `Standards updated:` plus a one-line summary of each new entry, then update its acknowledged date.

- **2026-04-30d** — `## Player update` now mirrors the **entire section** under the heading (not just the first paragraph), preserving markdown formatting — multi-step instructions, numbered lists, code blocks, and inline `### sub-headings` all reach the player intact. Section bound is the next h1 or h2 heading, so use h3+ for any structure inside the player-facing block. Long updates that exceed Discord's 2000-char per-message limit are auto-chunked into consecutive messages with a small `_(continued)_` marker on each continuation; nothing is truncated.
- **2026-04-30c** — Bot/agent feedback path documented. When a bot or agent wants player input on a ticket, post a GitHub comment containing a `## Player update` heading; SCRIBE mirrors the section to the linked Discord thread (with the 📢 marker). Engineering context goes below a separator or a different heading and stays on GitHub. Two gotchas: (1) the comment author must not be a GitHub bot account — `gh` CLI through your PAT works because sender type is `User`, but a GitHub App account would be filtered. (2) Edits don't fire — only `action: created` is mirrored, so write the heading on first save.
- **2026-04-30b** — Removed unsupported fenced ` ```release-notes ` closing-comment fallback. Player summaries must live in the issue body now; the comment fallback was advertised but never wired into SCRIBE's release draft or close announcement.
- **2026-04-30a** — Initial: `## Player summary` (issue body) and `## Player update` (issue comments) headings introduced.

## `## Player summary` — issue body

Add this section to a player-visible issue **before closing** it. SCRIBE pulls the first paragraph into:

- The close announcement posted into the linked Discord thread (the `> quoted` line under the ✅).
- The per-thread followup when a release ships the fix (commit-log-attributed, see release pipeline notes).

Format:

```markdown
## Player summary

One short paragraph in plain language — what changed for the player, not what code changed. Keep it to a few sentences.
```

Heading match is case-insensitive. The parser stops at the next markdown heading at any level, then takes the first paragraph (up to the first blank line). If the section is missing or empty, the issue lands in the per-thread followup with no quoted summary, which is fine but less useful for the player.

There is no closing-comment fallback. The summary must live in the issue body.

## `## Player update` — GitHub issue comment

Add this heading inside a GitHub issue comment when you want the comment to reach the linked Discord thread. Without it, SCRIBE treats the comment as engineering chatter and does not mirror it.

This is the right path **whenever a bot or agent wants feedback from the player on a ticket** — phrasing a question, asking for a `/fq debug perf` dump, requesting a screenshot, etc. Keep the player-facing prompt short and self-contained; engineering context goes below a separator or a different heading and stays on GitHub.

Format:

```markdown
## Player update

The full section under this heading goes to the player in Discord — write as
much as you need to. Markdown formatting is preserved, so use lists, line
breaks, and code blocks freely.

To narrow this down, can you do the following:

1. Run `/console scriptProfile 1`
2. Reload your UI
3. Reproduce the slowness for ~30 seconds
4. Run `/fq debug perf` and paste the output below

If the slash command errors, let us know which step failed.

## Engineering note

Stack traces, hypotheses, links to other tickets — whatever's useful to the next agent reading this issue. Players never see anything below an h1 or h2 heading.
```

Section bound is the next h1 or h2 heading, so `### Steps` or `### Bonus question` inside the player-facing block stay in the player content. Long updates that exceed Discord's 2000-char per-message cap are auto-chunked into consecutive messages with a `_(continued)_` marker; nothing is truncated.

### Bot/agent gotchas

- **Author must not be a GitHub bot account.** SCRIBE filters `sender.type === 'Bot'` *before* checking for the heading — that's the loop guard against SCRIBE mirroring its own transcribed Discord-→-GitHub posts. Posting via `gh` CLI through your PAT works (sender type is `User`). A future GitHub App account would be filtered.
- **Edits don't fire.** Only `action: created` is mirrored. If you edit a comment to add `## Player update` after the fact, it won't reach Discord. Write the heading on the first save.

## Player-facing copy style

Both blocks should follow the same player-facing voice:

- Plain language. No file paths, no symbol names, no acronyms the player wouldn't know.
- Short. Two or three sentences is usually right.
- "What changed for the player" or "what we need from you," not "what we did in the code."
- No bug numbers, PR numbers, or internal IDs — SCRIBE adds the issue link on its own.
- Themed sections + short bullet links beat engineering prose for release notes.
