# SCRIBE's role in a cog release

How a cog release moves through scribe, end to end. The release *policy* — what
the channels mean, when to cut an alpha, the F1–F8 pre-tag checklist — lives in
[`cogworks/runbooks/branch-and-release-flow.md`](https://github.com/gezmodean-wow/cogworks/blob/main/runbooks/branch-and-release-flow.md).
This file covers only what scribe does with it.

## The model scribe implements

Three facts from the runbook drive everything below:

1. **Channels label exposure, not maturity.** Every tag ships functionally
   complete code. Alpha is opt-in player exposure; release is the default
   install.
2. **Promotion is a re-tag of the same commit.** `v0.14.0-alpha1` at commit C
   becomes `v0.14.0` at commit C. The version number means new code; the
   channel change does not.
3. **`## Player summary` is the source of player-facing copy.** Written in the
   issue body by whoever fixed it.

Consequence for scribe: a stable tag is not automatically "here are new fixes."
It may be "the fixes you already had are now the default." Those read
differently to a player, so scribe tells them apart before it writes anything.

## Pipeline

```
GitHub release published
        │
        ├─ classify channel      alpha / beta / release   (tag name + prerelease flag)
        ├─ detect promotion      does a prior vX.Y.Z-alphaN sit on this exact commit?
        ├─ collect issues        commit log since prior tag  +  recorded cohort
        ├─ compose draft         full / delta / promotion render
        │
        ▼
  #release-review  ──[Approve & publish]──▶  #releases
        │                                        │
        │                                        ├─ per-thread followups
        │                                        └─ per-issue channel state written
        └─ Edit / Discard
```

Nothing posts publicly without a human pressing **Approve & publish**.

## Promotion detection

On a stable tag (`vX.Y.Z`, no `-alphaN` / `-betaN` / `-rcN`):

1. Look up prior tags of the same `MAJOR.MINOR.PATCH` that carry a prerelease
   suffix, from `release_announcements`.
2. Resolve each to its commit SHA, and this tag too.
3. If any prior prerelease sits on the same commit, this release is a
   **promotion**.

A failure to resolve a SHA degrades to "not a promotion" — the historical
newly-fixed framing — rather than guessing.

**Cohort width.** The SHA match identifies the promotion; the *cohort* is every
prior prerelease of that version. Promoting `v0.14.0` makes the whole line the
default install, so an issue first shipped in `-alpha1` is promoted even when
the SHA match came from `-alpha2`. Narrowing the cohort to same-commit tags
would drop those issues out of both announcement sections.

## Per-issue channel state

Five columns on `thread_issue_map`, written at publish time:

| Column | Written when | Overwritten |
|---|---|---|
| `first_released_tag` | first release that announces this issue | never |
| `first_released_channel` | same | never |
| `first_released_at` | same | never |
| `promoted_to_stable_tag` | a promotion picks up an issue that first shipped in alpha/beta | never |
| `promoted_to_stable_at` | same | never |

Write-once in both cases: a later release must not rewrite the history of where
a fix first appeared.

Rows created before this feature are NULL and are treated as "newly fixed."
Behavior applies forward only — there is no backfill, by design. The first
stable tag after adoption will therefore announce its cohort as newly fixed even
if an alpha shipped it earlier; that self-corrects from the next alpha onward.

## What a player sees

Three framings, chosen per issue, not per release:

| Situation | Thread followup |
|---|---|
| First ship, alpha or beta | 📦 Fixed in `v0.14.0-alpha1` — opt-in via the alpha channel. Stable promotion to follow. |
| First ship, stable | 📦 Fixed in `v0.14.0` — default channel. |
| Promoted to stable | ✅ Promoted to stable in `v0.14.0` — now the default install. Players on the alpha/beta channel are already running this code. |

The `#releases` post for a promotion leads with `## Promoting v0.14.0 to stable`
and splits its issues into **Promoted from alpha/beta** and **Newly fixed in
this release**, rather than rendering the RELEASES.md prose again — that prose
belongs to the release that first shipped the code.

## Draft render modes

| Mode | When | Body |
|---|---|---|
| Full | first stable or first prerelease on a `MAJOR.MINOR` line | RELEASES.md section + `_Issues shipped_` footer |
| Delta | later patches and prereleases on that line | `## Changes since <prior tag>` + per-issue bullets |
| Promotion | stable tag that re-tags a prerelease commit | promotion sections above |

## Commands

| Command | Use |
|---|---|
| `/release-check <cog> [tag]` | Before tagging. Pending issues since the last tag, missing player summaries, RELEASES.md section status, and whether the tag would be a promotion. |
| `/release-redraft <cog> <tag> [repost]` | After fixing a summary or RELEASES.md. Regenerates the draft — promotion-aware, so a redraft can't disagree with the original about what kind of release it is. |

`/release-check` complements the cog-side `scripts/pre-tag-check.sh`: that runs
locally against the working tree, this runs against what GitHub sees, from where
the announcement is actually written.

## Deliberate non-goals

- **Scribe never tags or merges anything.** Promotion is engineer-initiated;
  scribe models and announces it.
- **No Discord-side editing of channel state.** The model is read-only in v1;
  the release events are the only writer.
