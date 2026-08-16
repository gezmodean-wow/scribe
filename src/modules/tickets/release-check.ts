// `/release-check <cog> [tag]` — pre-tag readiness report (issue #3).
//
// The engineer runs this in Discord before cutting a tag. It answers the
// questions that otherwise get answered by tagging and then noticing the
// announcement is wrong:
//
//   - what has landed on the default branch since the last release?
//   - which of those issues have no `## Player summary` to announce with?
//   - does RELEASES.md have a section the drafter will actually find?
//   - would this tag be a promotion (a re-tag of an alpha/beta commit)?
//
// Complements the cog-side `scripts/pre-tag-check.sh` F1–F7, which runs
// locally against the working tree. This one runs against what GitHub sees,
// from where the release actually gets announced.

import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import { findCogForChannel, type CogChannel } from './channels.js';
import type { TicketsModuleDeps } from './index.js';
import { chunkForDiscord } from './mirror.js';
import {
  classifyReleasesSectionMatch,
  isPrereleaseTag,
  parseReleaseTag,
} from './release-notes.js';
import {
  classifyReleaseChannel,
  collectIssueNumbersFromCommits,
  fetchShippedIssueDetails,
  listPriorReleases,
  type ShippedIssue,
} from './releases.js';
import { selectPriorPrereleaseTags, tagsAtSameCommit } from './promotion.js';
import { releaseAnnouncements } from '../../core/db/schema.js';
import { and, eq } from 'drizzle-orm';

const DISCORD_MESSAGE_CAP = 2000;

export async function handleReleaseCheck(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const proposedTag = interaction.options.getString('tag', false);

  if (channel.type !== ChannelType.GuildForum) {
    await interaction.reply({
      content: 'Pick a forum channel.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const cog = await findCogForChannel(deps.db, channel.id);
  if (!cog) {
    await interaction.editReply(
      'This channel isn\'t linked to a cog repository. Run `/cog-link` first.'
    );
    return;
  }

  const lines = await runReleaseCheck(cog, proposedTag, deps);
  const chunks = chunkForDiscord(
    lines.join('\n'),
    DISCORD_MESSAGE_CAP,
    DISCORD_MESSAGE_CAP
  );
  await interaction.editReply(chunks[0]!);
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, ephemeral: true });
  }
}

export async function runReleaseCheck(
  cog: CogChannel,
  proposedTag: string | null,
  deps: TicketsModuleDeps
): Promise<string[]> {
  const owner = cog.githubOwner;
  const repo = cog.githubRepo;
  const out: string[] = [
    `**Release check — ${owner}/${repo}**${proposedTag ? ` · proposed tag \`${proposedTag}\`` : ''}`,
  ];

  const { data: repoInfo } = await deps.github.rest.repos.get({ owner, repo });
  const head = repoInfo.default_branch;

  const priorReleases = await listPriorReleases(
    owner,
    repo,
    new Date().toISOString(),
    deps
  );
  const lastTag = priorReleases[0]?.tag_name ?? null;
  out.push(
    lastTag
      ? `Last release: \`${lastTag}\` · comparing against \`${head}\``
      : `No prior release — comparing the last 100 commits on \`${head}\``
  );

  const issues = await collectPendingIssues(owner, repo, head, lastTag, cog, deps);
  out.push('');
  out.push(...renderIssueSection(issues));

  out.push('');
  out.push(
    ...(await renderReleasesSection(owner, repo, head, proposedTag, deps))
  );

  if (proposedTag) {
    out.push('');
    out.push(...(await renderPromotionSection(owner, repo, head, proposedTag, deps)));
  }

  out.push('');
  out.push(...renderNextActions(issues, proposedTag));
  return out;
}

async function collectPendingIssues(
  owner: string,
  repo: string,
  head: string,
  lastTag: string | null,
  cog: CogChannel,
  deps: TicketsModuleDeps
): Promise<ShippedIssue[]> {
  // Same 250-commit ceiling as the release drafter's compare call; the
  // bootstrap path (no prior tag) mirrors it too.
  const commits = lastTag
    ? (
        await deps.github.rest.repos.compareCommits({
          owner,
          repo,
          base: lastTag,
          head,
        })
      ).data.commits
    : (
        await deps.github.rest.repos.listCommits({
          owner,
          repo,
          sha: head,
          per_page: 100,
        })
      ).data;

  const numbers = collectIssueNumbersFromCommits(commits, cog.cogIdPrefix);
  return fetchShippedIssueDetails(owner, repo, numbers, deps);
}

function renderIssueSection(issues: ShippedIssue[]): string[] {
  if (issues.length === 0) {
    return ['**Issues since last tag:** _none referenced in the commit log._'];
  }
  const lines = [`**Issues since last tag** (${issues.length})`];
  for (const issue of issues) {
    const flags: string[] = [];
    if (!issue.summary) {
      flags.push(
        issue.hadPlayerUpdate
          ? '⚠️ no Player summary (has Player updates)'
          : '⚠️ no Player summary'
      );
    }
    // An issue still open at tag time isn't necessarily wrong — the commit
    // may be a partial fix — but it's worth seeing before the tag goes out.
    if (issue.state === 'open') flags.push('🔓 still open');
    lines.push(
      `• #${issue.number} ${issue.title}${flags.length ? ` — ${flags.join(', ')}` : ''}`
    );
  }
  return lines;
}

async function renderReleasesSection(
  owner: string,
  repo: string,
  head: string,
  proposedTag: string | null,
  deps: TicketsModuleDeps
): Promise<string[]> {
  let raw: string | null = null;
  try {
    const { data } = await deps.github.rest.repos.getContent({
      owner,
      repo,
      path: 'RELEASES.md',
      ref: head,
    });
    if (!Array.isArray(data) && data.type === 'file' && 'content' in data) {
      raw = Buffer.from(data.content, 'base64').toString('utf-8');
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      deps.log.warn(
        { err, repo: `${owner}/${repo}` },
        'release-check: could not fetch RELEASES.md'
      );
    }
  }

  if (raw === null) {
    return [
      '**RELEASES.md:** ❌ not found on the default branch — the draft will fall back to per-issue bullets.',
    ];
  }
  if (!proposedTag) {
    return [
      '**RELEASES.md:** ✅ present. Pass a `tag:` to check whether it has a matching section.',
    ];
  }

  const match = classifyReleasesSectionMatch(raw, proposedTag);
  const base = proposedTag.replace(/-(?:alpha|beta|rc)\w*$/i, '');
  switch (match) {
    case 'exact':
      return [`**RELEASES.md:** ✅ has a \`## ${proposedTag}\` section.`];
    case 'base':
      return [
        `**RELEASES.md:** ✅ falls back to the \`## ${base}\` section (normal for an alpha series).`,
      ];
    case 'unreleased':
      return [
        `**RELEASES.md:** ⚠️ no \`## ${proposedTag}\` or \`## ${base}\` section — will fall back to \`## Unreleased\`. Rename that heading before tagging.`,
      ];
    default:
      return [
        `**RELEASES.md:** ❌ no matching section for \`${proposedTag}\`. The draft will fall back to per-issue bullets with a warning.`,
      ];
  }
}

async function renderPromotionSection(
  owner: string,
  repo: string,
  head: string,
  proposedTag: string,
  deps: TicketsModuleDeps
): Promise<string[]> {
  const parsed = parseReleaseTag(proposedTag);
  if (!parsed) {
    return [
      `**Channel:** ⚠️ \`${proposedTag}\` doesn't parse as \`MAJOR.MINOR(.PATCH)(-PRE)\` — the drafter will fall back to full notes.`,
    ];
  }
  const channelKind = classifyReleaseChannel(proposedTag, isPrereleaseTag(parsed));
  if (channelKind !== 'release') {
    return [
      `**Channel:** \`${channelKind}\` — opt-in exposure. Players stay on the current stable until this is promoted.`,
    ];
  }

  const rows = await deps.db
    .select({ tag: releaseAnnouncements.tag })
    .from(releaseAnnouncements)
    .where(
      and(
        eq(releaseAnnouncements.githubOwner, owner),
        eq(releaseAnnouncements.githubRepo, repo)
      )
    );
  const priors = selectPriorPrereleaseTags(
    proposedTag,
    rows.map((r) => r.tag)
  );
  if (priors.length === 0) {
    return [
      '**Channel:** `release` — no prior alpha/beta of this version, so this would announce as newly fixed.',
    ];
  }

  // Compare against the branch head, since that's the commit the tag would
  // land on if it were cut right now.
  const headSha = await resolveSha(owner, repo, head, deps);
  const shaByTag = new Map<string, string>();
  for (const tag of priors) {
    const sha = await resolveSha(owner, repo, tag, deps);
    if (sha) shaByTag.set(tag, sha);
  }
  const sameCommit = tagsAtSameCommit(headSha, priors, shaByTag);

  if (sameCommit.length > 0) {
    return [
      `**Channel:** \`release\` — tagging \`${head}\` now is a **promotion** of ${sameCommit.map((t) => `\`${t}\``).join(', ')}. The announcement will use the promoted-to-stable framing.`,
    ];
  }
  return [
    `**Channel:** \`release\` — prior prereleases exist (${priors.map((t) => `\`${t}\``).join(', ')}) but \`${head}\` has moved past them, so this would announce as new code, not a promotion.`,
  ];
}

async function resolveSha(
  owner: string,
  repo: string,
  ref: string,
  deps: TicketsModuleDeps
): Promise<string | null> {
  try {
    const { data } = await deps.github.rest.repos.getCommit({
      owner,
      repo,
      ref,
    });
    return data.sha;
  } catch (err) {
    deps.log.warn(
      { err, repo: `${owner}/${repo}`, ref },
      'release-check: could not resolve ref to a commit'
    );
    return null;
  }
}

function renderNextActions(
  issues: ShippedIssue[],
  proposedTag: string | null
): string[] {
  const missing = issues.filter((i) => !i.summary);
  if (missing.length === 0) {
    return ['**Next:** nothing blocking — ready to tag.'];
  }
  const refs = missing.map((i) => `#${i.number}`).join(', ');
  return [
    `**Next:** add a \`## Player summary\` to ${refs}, then re-run \`/release-check\`` +
      (proposedTag ? ` with \`tag: ${proposedTag}\`.` : '.'),
  ];
}
