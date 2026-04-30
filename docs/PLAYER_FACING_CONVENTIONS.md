# Player-facing conventions

The single source of truth for the markdown headings SCRIBE looks for in GitHub issues and comments. Each cog's `CLAUDE.md` should link here rather than restate the rules — the parser lives in `src/modules/tickets/release-notes.ts` and changes here override anything cached in cog docs.

## `## Player summary` — issue body

Add this section to a player-visible issue **before closing** it. SCRIBE pulls the first paragraph into:

- The close announcement posted into the linked Discord thread (the `> quoted` line under the ✅).
- The bulleted "What changed" list in the next release announcement draft.

Format:

```markdown
## Player summary

One short paragraph in plain language — what changed for the player, not what code changed. Keep it to a few sentences.
```

Heading match is case-insensitive. The parser stops at the next markdown heading at any level, then takes the first paragraph (up to the first blank line). If the section is missing or empty, the issue lands in the release draft under **⚠️ No player summary written** and the draft warns staff to add the block and re-run `/release-redraft`.

There is no closing-comment fallback. The summary must live in the issue body. (An older fenced ` ```release-notes ` block in the closing comment was advertised in past docs but was never wired through — removed 2026-04-30.)

## `## Player update` — GitHub issue comment

Add this heading inside a GitHub issue comment when you want the comment to reach the linked Discord thread. Without it, SCRIBE treats the comment as engineering chatter and does not mirror it.

Format:

```markdown
## Player update

The first paragraph after this heading is what players will see in Discord. Keep it short, plain-language, and self-contained — anything below the next heading or blank line is engineering context that stays on GitHub.

## Engineering note

Whatever stack traces, links, and reasoning you want. Players never see this section.
```

Same parser rules as Player summary: case-insensitive heading match, first paragraph wins, sections beyond the next heading are dropped from the mirrored snippet. Comments authored by bots are skipped entirely (the bot accounts already have their own outbound paths).

## Player-facing copy style

Both blocks should follow the same player-facing voice:

- Plain language. No file paths, no symbol names, no acronyms the player wouldn't know.
- Short. Two or three sentences is usually right.
- "What changed for the player," not "what we did in the code."
- No bug numbers, PR numbers, or internal IDs — SCRIBE adds the issue link on its own.
