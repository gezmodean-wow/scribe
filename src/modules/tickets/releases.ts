import {
  ActionRowBuilder,
  type ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  EmbedBuilder,
  type ModalActionRowComponentBuilder,
  ModalBuilder,
  type ModalSubmitInteraction,
  type TextChannel,
  type ThreadChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { and, desc, eq } from 'drizzle-orm';
import {
  releaseAnnouncements,
  threadIssueMap,
  type ReleaseAnnouncement,
} from '../../core/db/schema.js';
import { findCogByRepo, type CogChannel } from './channels.js';
import type { TicketsModuleDeps } from './index.js';
import {
  extractPlayerSummary,
  extractPlayerUpdate,
  extractReleasesSection,
} from './release-notes.js';

export type ReleaseChannel = 'alpha' | 'beta' | 'release';

type ReleasePayload = {
  action: string;
  release: {
    id: number;
    tag_name: string;
    name?: string | null;
    html_url: string;
    body?: string | null;
    prerelease: boolean;
    published_at: string | null;
    created_at: string;
  };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
};

const CHANNEL_COLOR: Record<ReleaseChannel, number> = {
  alpha: 0xe67e22,
  beta: 0x3498db,
  release: 0x2ecc71,
};

const CHANNEL_BADGE: Record<ReleaseChannel, string> = {
  alpha: 'Alpha',
  beta: 'Beta',
  release: 'Release',
};

// Mirrors the rule used by each cog's release.yml so SCRIBE's classification
// stays in sync with what the BigWigs packager uploads to CurseForge / Wago.
export function classifyReleaseChannel(
  tag: string,
  prerelease: boolean
): ReleaseChannel {
  const lower = tag.toLowerCase();
  if (lower.includes('alpha')) return 'alpha';
  if (lower.includes('beta')) return 'beta';
  return prerelease ? 'beta' : 'release';
}

// CurseForge files page filtered to the matching release type. Their query
// param uses the same names we do (alpha / beta / release).
export function buildCurseforgeUrl(
  slug: string,
  channel: ReleaseChannel
): string {
  return `https://www.curseforge.com/wow/addons/${slug}/files?releaseType=${channel}`;
}

// Wago versions page filtered by stability. Note the naming difference: Wago
// uses "stable" rather than "release" for the stable channel.
export function buildWagoUrl(slug: string, channel: ReleaseChannel): string {
  const stability = channel === 'release' ? 'stable' : channel;
  return `https://addons.wago.io/addons/${slug}/versions?stability=${stability}`;
}

function buildDownloadLinks(
  cog: CogChannel,
  channel: ReleaseChannel
): string[] {
  const out: string[] = [];
  if (cog.curseforgeSlug) {
    out.push(`[CurseForge](${buildCurseforgeUrl(cog.curseforgeSlug, channel)})`);
  }
  if (cog.wagoSlug) {
    out.push(`[Wago](${buildWagoUrl(cog.wagoSlug, channel)})`);
  }
  return out;
}

export async function handleReleaseEvent(
  payload: ReleasePayload,
  deps: TicketsModuleDeps
): Promise<void> {
  if (payload.action !== 'published' && payload.action !== 'prereleased') {
    return;
  }

  const cog = await findCogByRepo(
    deps.db,
    payload.repository.owner.login,
    payload.repository.name
  );
  if (!cog) {
    deps.log.info(
      { repo: payload.repository.full_name, tag: payload.release.tag_name },
      'release event for unlinked repo, skipping'
    );
    return;
  }
  if (!cog.releaseReviewChannelId) {
    deps.log.info(
      { repo: payload.repository.full_name },
      'cog has no release_review_channel_id; skipping release draft'
    );
    return;
  }

  // De-dupe: GitHub fires `published` again on edit/republish. If we already
  // have a row for this tag, skip drafting to avoid spamming the review
  // channel. Manual `/release-redraft` covers the redraft path.
  const existing = await deps.db
    .select()
    .from(releaseAnnouncements)
    .where(
      and(
        eq(releaseAnnouncements.githubOwner, cog.githubOwner),
        eq(releaseAnnouncements.githubRepo, cog.githubRepo),
        eq(releaseAnnouncements.tag, payload.release.tag_name)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    deps.log.info(
      { repo: payload.repository.full_name, tag: payload.release.tag_name },
      'release already drafted; ignoring republish'
    );
    return;
  }

  await draftAndPost(payload, cog, deps);
}

export async function draftAndPost(
  payload: ReleasePayload,
  cog: CogChannel,
  deps: TicketsModuleDeps
): Promise<ReleaseAnnouncement | null> {
  const channelKind = classifyReleaseChannel(
    payload.release.tag_name,
    payload.release.prerelease
  );

  const [issues, releasesSection] = await Promise.all([
    collectShippedIssuesForRelease(
      payload.repository.owner.login,
      payload.repository.name,
      payload.release.tag_name,
      cog.cogIdPrefix,
      payload.release.published_at ?? payload.release.created_at,
      deps
    ),
    fetchReleasesSection(
      payload.repository.owner.login,
      payload.repository.name,
      payload.release.tag_name,
      deps
    ),
  ]);

  const draft = composeDraft({
    repoName: payload.repository.name,
    tag: payload.release.tag_name,
    title: payload.release.name ?? payload.release.tag_name,
    releaseUrl: payload.release.html_url,
    downloadLinks: buildDownloadLinks(cog, channelKind),
    channelKind,
    issues,
    releasesSection,
  });

  const reviewChannelId = cog.releaseReviewChannelId!;
  const reviewChannel = await fetchTextChannel(
    deps.discord,
    reviewChannelId,
    deps
  );
  if (!reviewChannel) return null;

  // ON CONFLICT DO NOTHING is the authoritative dedupe — the pre-SELECT in
  // handleReleaseEvent races against itself when GitHub fires `prereleased`
  // and `published` for the same tag in quick succession (both pass the
  // SELECT, both attempt to INSERT). Whichever loses the race here gets zero
  // rows back and bails cleanly without surfacing a unique-constraint error.
  const [row] = await deps.db
    .insert(releaseAnnouncements)
    .values({
      githubOwner: payload.repository.owner.login,
      githubRepo: payload.repository.name,
      tag: payload.release.tag_name,
      githubReleaseId: String(payload.release.id),
      releaseUrl: payload.release.html_url,
      channel: channelKind,
      prerelease: payload.release.prerelease,
      status: 'pending',
      reviewChannelId,
      announceChannelId: cog.releaseAnnounceChannelId ?? null,
      draftBody: draft,
    })
    .onConflictDoNothing({
      target: [
        releaseAnnouncements.githubOwner,
        releaseAnnouncements.githubRepo,
        releaseAnnouncements.tag,
      ],
    })
    .returning();
  if (!row) {
    deps.log.info(
      { repo: payload.repository.full_name, tag: payload.release.tag_name },
      'release draft already exists for tag (concurrent webhook); skipping'
    );
    return null;
  }

  const message = await reviewChannel.send({
    embeds: [buildReviewEmbed(row)],
    components: [buildReviewButtons(row.id)],
  });

  const [updated] = await deps.db
    .update(releaseAnnouncements)
    .set({ reviewMessageId: message.id, updatedAt: new Date() })
    .where(eq(releaseAnnouncements.id, row.id))
    .returning();

  deps.log.info(
    {
      repo: payload.repository.full_name,
      tag: payload.release.tag_name,
      channel: channelKind,
      reviewMessageId: message.id,
      issueCount: issues.length,
    },
    'release draft posted for review'
  );

  return updated ?? row;
}

type ClosedIssue = {
  number: number;
  title: string;
  htmlUrl: string;
  summary: string | null;
  // Only meaningful when summary is null — flips the warning-bucket bullet
  // from "no player-facing copy at all" to "had Player updates but didn't
  // promote a summary," which is almost always an oversight worth flagging.
  hadPlayerUpdate: boolean;
};

// Issue references in commit messages — what actually shipped between two
// release tags. Cog convention is `fix(FQ-N): subject` (and similar for other
// cogs); GitHub also auto-links `Closes #N` / `Fixes #N` / `Resolves #N`.
async function collectShippedIssuesForRelease(
  owner: string,
  repo: string,
  thisTag: string,
  cogIdPrefix: string,
  releasePublishedAt: string,
  deps: TicketsModuleDeps
): Promise<ClosedIssue[]> {
  const commits = await collectCommitsSincePriorRelease(
    owner,
    repo,
    thisTag,
    releasePublishedAt,
    deps
  );

  const escapedPrefix = cogIdPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRe = new RegExp(`\\b${escapedPrefix}-(\\d+)\\b`, 'gi');
  const closeRe = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

  const numbers = new Set<number>();
  for (const c of commits) {
    const msg = c.commit.message;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(msg)) !== null) {
      const n = Number.parseInt(m[1]!, 10);
      if (!Number.isNaN(n)) numbers.add(n);
    }
    while ((m = closeRe.exec(msg)) !== null) {
      const n = Number.parseInt(m[1]!, 10);
      if (!Number.isNaN(n)) numbers.add(n);
    }
  }

  const collected: ClosedIssue[] = [];
  for (const n of numbers) {
    try {
      const { data: issue } = await deps.github.rest.issues.get({
        owner,
        repo,
        issue_number: n,
      });
      if ('pull_request' in issue && issue.pull_request) continue;
      const summary = extractPlayerSummary(issue.body);
      let hadPlayerUpdate = false;
      if (!summary) {
        try {
          const { data: comments } =
            await deps.github.rest.issues.listComments({
              owner,
              repo,
              issue_number: n,
              per_page: 100,
            });
          hadPlayerUpdate = comments.some(
            (c) => extractPlayerUpdate(c.body) !== null
          );
        } catch (err) {
          deps.log.warn(
            { err, issueNumber: n, repo: `${owner}/${repo}` },
            'release: could not list comments for player-update check'
          );
        }
      }
      collected.push({
        number: issue.number,
        title: issue.title,
        htmlUrl: issue.html_url,
        summary,
        hadPlayerUpdate,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) {
        deps.log.warn(
          { err, issueNumber: n, repo: `${owner}/${repo}` },
          'release: could not fetch issue referenced in commit log'
        );
      }
    }
  }
  collected.sort((a, b) => a.number - b.number);
  return collected;
}

type CommitInfo = { commit: { message: string } };

async function collectCommitsSincePriorRelease(
  owner: string,
  repo: string,
  thisTag: string,
  releasePublishedAt: string,
  deps: TicketsModuleDeps
): Promise<CommitInfo[]> {
  const releaseDate = new Date(releasePublishedAt);
  const releases = await deps.github.paginate(
    deps.github.rest.repos.listReleases,
    { owner, repo, per_page: 50 }
  );
  const prior = releases
    .filter((r) => r.published_at && new Date(r.published_at) < releaseDate)
    .sort(
      (a, b) =>
        new Date(b.published_at!).getTime() -
        new Date(a.published_at!).getTime()
    )[0];

  if (prior?.tag_name) {
    // GitHub's compare endpoint caps the inline `commits` array at 250. For
    // the rapid alpha cadence these cogs use that's plenty; if a release ever
    // exceeds it we'll truncate the older end of the window, which is the
    // safer direction (newer commits = more likely to be the shipped fix).
    const { data } = await deps.github.rest.repos.compareCommits({
      owner,
      repo,
      base: prior.tag_name,
      head: thisTag,
    });
    return data.commits;
  }

  // First-ever release — no prior tag to compare against. Take the most
  // recent 100 commits reachable from this tag as a one-time bootstrap.
  const { data } = await deps.github.rest.repos.listCommits({
    owner,
    repo,
    sha: thisTag,
    per_page: 100,
  });
  return data;
}

// Fetches `RELEASES.md` at the tag's ref and extracts the section for this
// tag. This is the canonical body source: each cog's `.pkgmeta` routes the
// same file to CurseForge / Wago via `manual-changelog`, so what Discord
// announces matches what the project pages publish.
//
// Returns null if the file is absent (cog hasn't adopted the dual-changelog
// pattern yet — fall through to per-issue summary render) or if the file
// exists but no matching section is found (likely an authoring slip; the
// fallback render shows a warning prompting the dev to add the section).
export async function fetchReleasesSection(
  owner: string,
  repo: string,
  tag: string,
  deps: TicketsModuleDeps
): Promise<string | null> {
  let raw: string;
  try {
    const { data } = await deps.github.rest.repos.getContent({
      owner,
      repo,
      path: 'RELEASES.md',
      ref: tag,
    });
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
      return null;
    }
    raw = Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      deps.log.warn(
        { err, repo: `${owner}/${repo}`, tag },
        'release: could not fetch RELEASES.md at tag'
      );
    }
    return null;
  }

  const section = extractReleasesSection(raw, tag);
  if (!section) {
    deps.log.info(
      { repo: `${owner}/${repo}`, tag },
      'release: RELEASES.md exists but has no matching section for tag'
    );
  }
  return section;
}

export function composeDraft(input: {
  repoName: string;
  tag: string;
  title: string;
  releaseUrl: string;
  downloadLinks: string[];
  channelKind: ReleaseChannel;
  issues: ClosedIssue[];
  releasesSection: string | null;
}): string {
  const {
    repoName,
    tag,
    releaseUrl,
    downloadLinks,
    channelKind,
    issues,
    releasesSection,
  } = input;
  const badge = CHANNEL_BADGE[channelKind];
  const lines: string[] = [];
  lines.push(`**${repoName} ${tag}** · ${badge}`);
  const linksLine = [...downloadLinks, `[GitHub release](${releaseUrl})`].join(
    ' · '
  );
  lines.push(linksLine);
  lines.push('');

  if (releasesSection) {
    lines.push(releasesSection);
    // Trailing #N footer drives `fanOutThreadFollowups` (which scans the draft
    // body for issue refs) since RELEASES.md prose is themed, not per-issue.
    // Editors can remove individual numbers here to skip a thread followup.
    if (issues.length > 0) {
      lines.push('');
      lines.push('---');
      const refs = issues.map((i) => `#${i.number}`).join(' ');
      lines.push(`_Issues shipped: ${refs}_`);
    }
    return lines.join('\n');
  }

  // Fallback path: RELEASES.md missing or no matching section. Surface a
  // visible warning so the dev knows the canonical source needs updating,
  // then render the per-issue summaries that drove drafts before this change.
  lines.push(
    "_⚠️ RELEASES.md section for this tag not found. Add a `## " +
      tag +
      "` (or `## " +
      tag.replace(/-(?:alpha|beta|rc)\w*$/i, '') +
      "`) section to the cog's RELEASES.md and run `/release-redraft`. Falling back to per-issue `## Player summary` bullets below._"
  );
  lines.push('');

  if (issues.length === 0) {
    lines.push(
      '_(no issue references found in commits since the previous release)_'
    );
    return lines.join('\n');
  }

  const withSummary = issues.filter((i) => i.summary);
  const withoutSummary = issues.filter((i) => !i.summary);

  if (withSummary.length > 0) {
    lines.push('## What changed');
    for (const issue of withSummary) {
      lines.push(
        `- ${issue.summary} · [#${issue.number}](${issue.htmlUrl})`
      );
    }
  }
  if (withoutSummary.length > 0) {
    lines.push('');
    lines.push('## ⚠️ No player summary written');
    lines.push(
      '_Add a `## Player summary` section to the issue body, then run `/release-redraft`._'
    );
    for (const issue of withoutSummary) {
      const suffix = issue.hadPlayerUpdate
        ? ' — had Player updates but no Player summary in body'
        : '';
      lines.push(
        `- ${issue.title} · [#${issue.number}](${issue.htmlUrl})${suffix}`
      );
    }
  }

  return lines.join('\n');
}

export function buildReviewEmbed(row: ReleaseAnnouncement): EmbedBuilder {
  const channelKind = row.channel as ReleaseChannel;
  const color = CHANNEL_COLOR[channelKind] ?? 0x95a5a6;
  const description = clamp(row.draftBody, 4000);
  const statusLabel =
    row.status === 'published'
      ? '✅ Published'
      : row.status === 'discarded'
        ? '🗑 Discarded'
        : '📝 Pending review';
  return new EmbedBuilder()
    .setTitle(`${row.githubRepo} ${row.tag}`)
    .setURL(row.releaseUrl)
    .setDescription(description)
    .setColor(color)
    .setFooter({
      text: `${statusLabel} · channel: ${channelKind} · id ${row.id}`,
    });
}

export function buildReviewButtons(
  rowId: number
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`release-approve:${rowId}`)
      .setLabel('Approve & publish')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`release-edit:${rowId}`)
      .setLabel('Edit')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`release-discard:${rowId}`)
      .setLabel('Discard')
      .setStyle(ButtonStyle.Danger)
  );
}

export async function fetchTextChannel(
  discord: Client,
  channelId: string,
  deps: TicketsModuleDeps
): Promise<TextChannel | null> {
  const channel = await discord.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    deps.log.warn(
      { channelId },
      'release: configured channel is not a guild text channel'
    );
    return null;
  }
  return channel as TextChannel;
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export async function findReleaseAnnouncement(
  deps: TicketsModuleDeps,
  owner: string,
  repo: string,
  tag: string
): Promise<ReleaseAnnouncement | undefined> {
  const rows = await deps.db
    .select()
    .from(releaseAnnouncements)
    .where(
      and(
        eq(releaseAnnouncements.githubOwner, owner),
        eq(releaseAnnouncements.githubRepo, repo),
        eq(releaseAnnouncements.tag, tag)
      )
    )
    .orderBy(desc(releaseAnnouncements.id))
    .limit(1);
  return rows[0];
}

export const EDIT_MODAL_PREFIX = 'release-edit-modal:';
const APPROVE_PREFIX = 'release-approve:';
const EDIT_PREFIX = 'release-edit:';
const DISCARD_PREFIX = 'release-discard:';

export function isReleaseButtonId(customId: string): boolean {
  return (
    customId.startsWith(APPROVE_PREFIX) ||
    customId.startsWith(EDIT_PREFIX) ||
    customId.startsWith(DISCARD_PREFIX)
  );
}

export async function handleReleaseButton(
  interaction: ButtonInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
  const id = interaction.customId;
  const rowId = parseRowId(id);
  if (rowId === null) return;

  const [row] = await deps.db
    .select()
    .from(releaseAnnouncements)
    .where(eq(releaseAnnouncements.id, rowId))
    .limit(1);
  if (!row) {
    await interaction.reply({
      content: 'Release draft not found (already discarded?).',
      ephemeral: true,
    });
    return;
  }

  if (id.startsWith(EDIT_PREFIX)) {
    await openEditModal(interaction, row);
    return;
  }
  if (id.startsWith(APPROVE_PREFIX)) {
    await approveAndPublish(interaction, row, deps);
    return;
  }
  if (id.startsWith(DISCARD_PREFIX)) {
    await discardDraft(interaction, row, deps);
    return;
  }
}

export async function handleReleaseModalSubmit(
  interaction: ModalSubmitInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
  const id = interaction.customId;
  if (!id.startsWith(EDIT_MODAL_PREFIX)) return;
  const rowId = Number.parseInt(id.slice(EDIT_MODAL_PREFIX.length), 10);
  if (Number.isNaN(rowId)) return;

  const newBody = interaction.fields.getTextInputValue('body');
  const [updated] = await deps.db
    .update(releaseAnnouncements)
    .set({ draftBody: newBody, updatedAt: new Date() })
    .where(eq(releaseAnnouncements.id, rowId))
    .returning();
  if (!updated) {
    await interaction.reply({
      content: 'Draft not found.',
      ephemeral: true,
    });
    return;
  }

  await rerenderReviewMessage(interaction.client, updated, deps);
  await interaction.reply({ content: 'Draft updated.', ephemeral: true });
}

function parseRowId(customId: string): number | null {
  const idx = customId.lastIndexOf(':');
  if (idx === -1) return null;
  const n = Number.parseInt(customId.slice(idx + 1), 10);
  return Number.isNaN(n) ? null : n;
}

async function openEditModal(
  interaction: ButtonInteraction,
  row: ReleaseAnnouncement
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`${EDIT_MODAL_PREFIX}${row.id}`)
    .setTitle(`Edit ${row.githubRepo} ${row.tag}`.slice(0, 45));
  const input = new TextInputBuilder()
    .setCustomId('body')
    .setLabel('Announcement body (markdown)')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(row.draftBody.slice(0, 4000))
    .setMaxLength(4000)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(input)
  );
  await interaction.showModal(modal);
}

async function discardDraft(
  interaction: ButtonInteraction,
  row: ReleaseAnnouncement,
  deps: TicketsModuleDeps
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  await deps.db
    .update(releaseAnnouncements)
    .set({ status: 'discarded', updatedAt: new Date() })
    .where(eq(releaseAnnouncements.id, row.id));
  await interaction.message.delete().catch(() => {});
  await interaction.editReply(
    `Discarded draft for ${row.githubRepo} ${row.tag}.`
  );
  deps.log.info(
    { rowId: row.id, repo: `${row.githubOwner}/${row.githubRepo}`, tag: row.tag },
    'release draft discarded'
  );
}

async function approveAndPublish(
  interaction: ButtonInteraction,
  row: ReleaseAnnouncement,
  deps: TicketsModuleDeps
): Promise<void> {
  if (row.status === 'published') {
    await interaction.reply({
      content: 'This draft is already published.',
      ephemeral: true,
    });
    return;
  }
  if (row.status === 'discarded') {
    await interaction.reply({
      content: 'This draft was discarded. Use `/release-redraft` to restart.',
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const cog = await findCogByRepo(deps.db, row.githubOwner, row.githubRepo);
  if (!cog) {
    await interaction.editReply('Cog config not found for this repo.');
    return;
  }
  const announceChannelId = row.announceChannelId ?? cog.releaseAnnounceChannelId;
  if (!announceChannelId) {
    await interaction.editReply(
      'No announce channel configured. Run `/cog-release-set` first.'
    );
    return;
  }

  const announceChannel = await fetchTextChannel(
    interaction.client,
    announceChannelId,
    deps
  );
  if (!announceChannel) {
    await interaction.editReply('Announce channel is not reachable.');
    return;
  }

  const message = await announceChannel.send({
    embeds: [buildAnnounceEmbed(row)],
  });

  const [updated] = await deps.db
    .update(releaseAnnouncements)
    .set({
      status: 'published',
      announceChannelId,
      announceMessageId: message.id,
      publishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(releaseAnnouncements.id, row.id))
    .returning();

  if (updated) {
    await rerenderReviewMessage(interaction.client, updated, deps);
  }

  // Fan-out to per-thread followups happens after the public post; failures
  // here don't roll back the announcement, just get logged.
  const fanout = await fanOutThreadFollowups(
    updated ?? row,
    cog,
    interaction.client,
    deps
  );

  await interaction.editReply(
    `Published to <#${announceChannelId}> · ${fanout.posted} thread followup(s) sent` +
      (fanout.skipped > 0 ? ` (${fanout.skipped} skipped)` : '')
  );
  deps.log.info(
    {
      rowId: row.id,
      repo: `${row.githubOwner}/${row.githubRepo}`,
      tag: row.tag,
      fanout,
    },
    'release published'
  );
}

export function buildAnnounceEmbed(row: ReleaseAnnouncement): EmbedBuilder {
  const channelKind = row.channel as ReleaseChannel;
  const color = CHANNEL_COLOR[channelKind] ?? 0x95a5a6;
  return new EmbedBuilder()
    .setTitle(`${row.githubRepo} ${row.tag}`)
    .setURL(row.releaseUrl)
    .setDescription(clamp(row.draftBody, 4000))
    .setColor(color)
    .setFooter({ text: `${CHANNEL_BADGE[channelKind] ?? 'Release'}` });
}

async function rerenderReviewMessage(
  discord: Client,
  row: ReleaseAnnouncement,
  deps: TicketsModuleDeps
): Promise<void> {
  if (!row.reviewChannelId || !row.reviewMessageId) return;
  const channel = await fetchTextChannel(discord, row.reviewChannelId, deps);
  if (!channel) return;
  const msg = await channel.messages
    .fetch(row.reviewMessageId)
    .catch(() => null);
  if (!msg) return;
  const components =
    row.status === 'pending' ? [buildReviewButtons(row.id)] : [];
  await msg
    .edit({
      embeds: [buildReviewEmbed(row)],
      components,
    })
    .catch((err) =>
      deps.log.warn({ err, rowId: row.id }, 'could not re-render review message')
    );
}

type FanoutResult = { posted: number; skipped: number };

async function fanOutThreadFollowups(
  row: ReleaseAnnouncement,
  cog: CogChannel,
  discord: Client,
  deps: TicketsModuleDeps
): Promise<FanoutResult> {
  const issueNumbers = collectIssueNumbersFromBody(row.draftBody);
  if (issueNumbers.size === 0) return { posted: 0, skipped: 0 };

  let posted = 0;
  let skipped = 0;

  for (const number of issueNumbers) {
    const [link] = await deps.db
      .select()
      .from(threadIssueMap)
      .where(
        and(
          eq(threadIssueMap.githubOwner, row.githubOwner),
          eq(threadIssueMap.githubRepo, row.githubRepo),
          eq(threadIssueMap.githubIssueNumber, number)
        )
      )
      .limit(1);
    if (!link) {
      skipped++;
      continue;
    }
    const channel = await discord.channels
      .fetch(link.discordThreadId)
      .catch(() => null);
    if (!channel?.isThread()) {
      skipped++;
      continue;
    }
    const thread = channel as ThreadChannel;
    const msg = buildThreadFollowup(row, cog);
    await thread.send(msg).then(
      () => posted++,
      (err) => {
        skipped++;
        deps.log.warn(
          { err, threadId: thread.id, issue: number },
          'release: could not post thread followup'
        );
      }
    );
  }
  return { posted, skipped };
}

function buildThreadFollowup(
  row: ReleaseAnnouncement,
  cog: CogChannel
): string {
  const channelKind = row.channel as ReleaseChannel;
  const parts = [`📦 Fixed in [${row.tag}](${row.releaseUrl})`];
  for (const link of buildDownloadLinks(cog, channelKind)) {
    parts.push(`· ${link}`);
  }
  return parts.join(' ');
}

// Pulls every #N reference out of the draft markdown. Used at fan-out time so
// the editor's bullet list (potentially curated/reordered) still drives which
// threads get pinged. Repos other than this one (e.g. cross-repo references)
// are filtered out by the thread_issue_map lookup.
function collectIssueNumbersFromBody(body: string): Set<number> {
  const out = new Set<number>();
  const re = /(?:^|[\s(\[])#(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const n = Number.parseInt(m[1]!, 10);
    if (!Number.isNaN(n)) out.add(n);
  }
  return out;
}

export type RedraftOutcome =
  | { kind: 'drafted'; row: ReleaseAnnouncement }
  | { kind: 'pending-refreshed'; row: ReleaseAnnouncement }
  | { kind: 'announce-edited'; row: ReleaseAnnouncement }
  | { kind: 'announce-reposted'; row: ReleaseAnnouncement; fanout: FanoutResult };

export async function redraftRelease(
  cog: CogChannel,
  tag: string,
  repost: boolean,
  deps: TicketsModuleDeps,
  discord: Client
): Promise<RedraftOutcome | { kind: 'error'; message: string }> {
  const owner = cog.githubOwner;
  const repo = cog.githubRepo;

  let release;
  try {
    const { data } = await deps.github.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag,
    });
    release = data;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      return { kind: 'error', message: `No release found at \`${tag}\`.` };
    }
    throw err;
  }

  const channelKind = classifyReleaseChannel(release.tag_name, release.prerelease);
  const [issues, releasesSection] = await Promise.all([
    collectShippedIssuesForRelease(
      owner,
      repo,
      release.tag_name,
      cog.cogIdPrefix,
      release.published_at ?? release.created_at,
      deps
    ),
    fetchReleasesSection(owner, repo, release.tag_name, deps),
  ]);
  const draftBody = composeDraft({
    repoName: repo,
    tag: release.tag_name,
    title: release.name ?? release.tag_name,
    releaseUrl: release.html_url,
    downloadLinks: buildDownloadLinks(cog, channelKind),
    channelKind,
    issues,
    releasesSection,
  });

  const existing = await findReleaseAnnouncement(deps, owner, repo, tag);

  if (!existing || existing.status === 'discarded') {
    if (!cog.releaseReviewChannelId) {
      return {
        kind: 'error',
        message:
          'No review channel configured. Run `/cog-release-set` with a `review` channel first.',
      };
    }
    const reviewChannel = await fetchTextChannel(
      discord,
      cog.releaseReviewChannelId,
      deps
    );
    if (!reviewChannel) {
      return { kind: 'error', message: 'Review channel is not reachable.' };
    }

    let row: ReleaseAnnouncement;
    if (existing) {
      const [updated] = await deps.db
        .update(releaseAnnouncements)
        .set({
          status: 'pending',
          channel: channelKind,
          prerelease: release.prerelease,
          githubReleaseId: String(release.id),
          releaseUrl: release.html_url,
          draftBody,
          announceChannelId: cog.releaseAnnounceChannelId ?? null,
          announceMessageId: null,
          publishedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(releaseAnnouncements.id, existing.id))
        .returning();
      row = updated!;
    } else {
      const [inserted] = await deps.db
        .insert(releaseAnnouncements)
        .values({
          githubOwner: owner,
          githubRepo: repo,
          tag: release.tag_name,
          githubReleaseId: String(release.id),
          releaseUrl: release.html_url,
          channel: channelKind,
          prerelease: release.prerelease,
          status: 'pending',
          reviewChannelId: cog.releaseReviewChannelId,
          announceChannelId: cog.releaseAnnounceChannelId ?? null,
          draftBody,
        })
        .returning();
      row = inserted!;
    }

    const message = await reviewChannel.send({
      embeds: [buildReviewEmbed(row)],
      components: [buildReviewButtons(row.id)],
    });
    const [withMsg] = await deps.db
      .update(releaseAnnouncements)
      .set({
        reviewChannelId: reviewChannel.id,
        reviewMessageId: message.id,
        updatedAt: new Date(),
      })
      .where(eq(releaseAnnouncements.id, row.id))
      .returning();
    return { kind: 'drafted', row: withMsg ?? row };
  }

  // Existing row — update body, decide what to do based on status.
  const [updated] = await deps.db
    .update(releaseAnnouncements)
    .set({
      draftBody,
      channel: channelKind,
      prerelease: release.prerelease,
      releaseUrl: release.html_url,
      githubReleaseId: String(release.id),
      updatedAt: new Date(),
    })
    .where(eq(releaseAnnouncements.id, existing.id))
    .returning();
  const row = updated!;

  if (row.status === 'pending') {
    await rerenderReviewMessage(discord, row, deps);
    return { kind: 'pending-refreshed', row };
  }

  // status === 'published'
  if (!row.announceChannelId) {
    return {
      kind: 'error',
      message:
        'Published row has no announce channel id (data error). Cannot edit.',
    };
  }
  const announceChannel = await fetchTextChannel(
    discord,
    row.announceChannelId,
    deps
  );
  if (!announceChannel) {
    return { kind: 'error', message: 'Announce channel is not reachable.' };
  }

  if (repost) {
    const repostBody = `**Updated notes for ${row.tag}:**`;
    const message = await announceChannel.send({
      content: repostBody,
      embeds: [buildAnnounceEmbed(row)],
    });
    const [final] = await deps.db
      .update(releaseAnnouncements)
      .set({
        announceMessageId: message.id,
        updatedAt: new Date(),
      })
      .where(eq(releaseAnnouncements.id, row.id))
      .returning();
    const cogReloaded =
      (await findCogByRepo(deps.db, owner, repo)) ?? cog;
    const fanout = await fanOutThreadFollowups(
      final ?? row,
      cogReloaded,
      discord,
      deps
    );
    if (final) await rerenderReviewMessage(discord, final, deps);
    return { kind: 'announce-reposted', row: final ?? row, fanout };
  }

  if (!row.announceMessageId) {
    return {
      kind: 'error',
      message:
        'Original announce message id missing — pass `repost: true` to send a fresh message.',
    };
  }
  const original = await announceChannel.messages
    .fetch(row.announceMessageId)
    .catch(() => null);
  if (!original) {
    return {
      kind: 'error',
      message:
        'Original announce message not found — pass `repost: true` to send a fresh message.',
    };
  }
  await original.edit({ embeds: [buildAnnounceEmbed(row)] });
  await rerenderReviewMessage(discord, row, deps);
  return { kind: 'announce-edited', row };
}
