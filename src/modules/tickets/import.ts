import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ForumChannel,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { and, eq, inArray } from 'drizzle-orm';
import { threadIssueMap } from '../../core/db/schema.js';
import { findCogForChannel, type CogChannel } from './channels.js';
import type { TicketsModuleDeps } from './index.js';
import { extractPlayerSummary } from './release-notes.js';
import { resolveStatusKey } from './status.js';

const SELECT_ID_PREFIX = 'import-issues:select:';
const CONFIRM_ID_PREFIX = 'import-issues:confirm:';
const CANCEL_ID = 'import-issues:cancel';
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_OPTIONS_PER_PAGE = 25;
const DISCORD_MAX_THREAD_NAME = 100;
const DISCORD_MAX_APPLIED_TAGS = 5;

export function isImportComponentId(customId: string): boolean {
  return (
    customId.startsWith(SELECT_ID_PREFIX) ||
    customId.startsWith(CONFIRM_ID_PREFIX) ||
    customId === CANCEL_ID
  );
}

type IssueState = 'open' | 'closed' | 'all';

type GhIssue = {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  state: string;
  state_reason?: string | null;
  labels: Array<string | { name?: string | null }>;
  pull_request?: unknown;
  node_id: string;
};

type SessionState = {
  selections: string[];
  channelId: string;
  state: IssueState;
  expiresAt: number;
};

const sessions = new Map<string, SessionState>();

function pruneExpired(now = Date.now()): void {
  for (const [k, v] of sessions) {
    if (v.expiresAt <= now) sessions.delete(k);
  }
}

function labelNames(issue: GhIssue): string[] {
  return issue.labels
    .map((l) => (typeof l === 'string' ? l : (l.name ?? null)))
    .filter((n): n is string => Boolean(n));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

export async function handleCogImportIssues(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const stateOpt = interaction.options.getString('state', false);
  const state: IssueState =
    stateOpt === 'closed' || stateOpt === 'all' ? stateOpt : 'open';

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

  const issues = (await deps.github.paginate(
    deps.github.rest.issues.listForRepo,
    {
      owner: cog.githubOwner,
      repo: cog.githubRepo,
      state,
      per_page: 100,
      sort: 'created',
      direction: 'asc',
    }
  )) as GhIssue[];

  const issuesOnly = issues.filter(
    (i) => !('pull_request' in i && i.pull_request)
  );

  const stateLabel = state === 'all' ? '' : state + ' ';

  if (issuesOnly.length === 0) {
    await interaction.editReply(
      `No ${stateLabel}issues found in **${cog.githubOwner}/${cog.githubRepo}**.`
    );
    return;
  }

  const numbers = issuesOnly.map((i) => i.number);
  const mappedRows = await deps.db
    .select({ n: threadIssueMap.githubIssueNumber })
    .from(threadIssueMap)
    .where(
      and(
        eq(threadIssueMap.githubOwner, cog.githubOwner),
        eq(threadIssueMap.githubRepo, cog.githubRepo),
        inArray(threadIssueMap.githubIssueNumber, numbers)
      )
    );
  const mapped = new Set(mappedRows.map((r) => r.n));
  const untracked = issuesOnly.filter((i) => !mapped.has(i.number));

  if (untracked.length === 0) {
    await interaction.editReply(
      `All ${issuesOnly.length} ${stateLabel}issue(s) in **${cog.githubOwner}/${cog.githubRepo}** are already mirrored to threads.`
    );
    return;
  }

  const page = untracked.slice(0, MAX_OPTIONS_PER_PAGE);
  const overflow = untracked.length - page.length;

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${SELECT_ID_PREFIX}${channel.id}:${state}`)
    .setPlaceholder('Pick issues to import (multi-select)')
    .setMinValues(1)
    .setMaxValues(page.length)
    .addOptions(
      page.map((i) => ({
        label: truncate(`#${i.number} — ${i.title}`, 100),
        value: String(i.number),
        description: truncate(
          labelNames(i).join(', ') || `state: ${i.state}`,
          100
        ),
      }))
    );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONFIRM_ID_PREFIX}${channel.id}:${state}`)
      .setLabel('Import selected')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CANCEL_ID)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  const headerLines = [
    `Found **${untracked.length}** untracked ${stateLabel}issue(s) in **${cog.githubOwner}/${cog.githubRepo}**.`,
  ];
  if (overflow > 0) {
    headerLines.push(
      `Showing the first ${page.length}. Re-run after importing these to see the remaining ${overflow}.`
    );
  }
  headerLines.push('Pick the ones to import, then click **Import selected**.');

  const reply = await interaction.editReply({
    content: headerLines.join('\n'),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      buttons,
    ],
  });

  pruneExpired();
  sessions.set(reply.id, {
    selections: [],
    channelId: channel.id,
    state,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

export async function handleImportSelect(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  pruneExpired();
  const session = sessions.get(interaction.message.id);
  if (!session) {
    await interaction
      .reply({
        content: 'This import session has expired. Re-run `/cog-import-issues`.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }
  session.selections = interaction.values;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  await interaction.deferUpdate().catch(() => {});
}

export async function handleImportButton(
  interaction: ButtonInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
  if (interaction.customId === CANCEL_ID) {
    sessions.delete(interaction.message.id);
    await interaction.update({
      content: 'Import cancelled.',
      components: [],
    });
    return;
  }

  if (!interaction.customId.startsWith(CONFIRM_ID_PREFIX)) return;

  pruneExpired();
  const session = sessions.get(interaction.message.id);
  if (!session) {
    await interaction
      .reply({
        content: 'This import session has expired. Re-run `/cog-import-issues`.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }
  if (session.selections.length === 0) {
    await interaction
      .reply({
        content: 'Pick at least one issue from the dropdown first.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  const cog = await findCogForChannel(deps.db, session.channelId);
  if (!cog) {
    sessions.delete(interaction.message.id);
    await interaction.update({
      content: 'The forum channel is no longer linked.',
      components: [],
    });
    return;
  }

  const forum = (await deps.discord.channels
    .fetch(session.channelId)
    .catch(() => null)) as ForumChannel | null;
  if (!forum) {
    sessions.delete(interaction.message.id);
    await interaction.update({
      content: 'Could not fetch the forum channel.',
      components: [],
    });
    return;
  }

  await interaction.update({
    content: `Importing ${session.selections.length} issue(s)...`,
    components: [],
  });

  const numbers = session.selections.map((s) => Number.parseInt(s, 10));
  let imported = 0;
  let failed = 0;
  const failedNumbers: number[] = [];

  const labelToTag = new Map<string, string>();
  for (const [tagId, label] of Object.entries(cog.tagLabelMap)) {
    labelToTag.set(label, tagId);
  }

  for (const n of numbers) {
    try {
      const { data: issue } = await deps.github.rest.issues.get({
        owner: cog.githubOwner,
        repo: cog.githubRepo,
        issue_number: n,
      });
      await importOneIssue(forum, cog, issue as GhIssue, labelToTag, deps);
      imported++;
    } catch (err) {
      failed++;
      failedNumbers.push(n);
      deps.log.warn(
        { err, issueNumber: n, repo: `${cog.githubOwner}/${cog.githubRepo}` },
        'cog-import-issues: failed to import issue'
      );
    }
  }

  sessions.delete(interaction.message.id);

  const lines = [
    `Import complete for <#${session.channelId}>:`,
    `• ${imported} thread(s) created`,
  ];
  if (failed > 0) {
    lines.push(
      `• ${failed} failure(s): ${failedNumbers.map((n) => `#${n}`).join(', ')} — check logs`
    );
  }
  await interaction.editReply({ content: lines.join('\n') }).catch(() => {});

  deps.log.info(
    {
      channelId: session.channelId,
      cog: `${cog.githubOwner}/${cog.githubRepo}`,
      requested: numbers.length,
      imported,
      failed,
    },
    'cog-import-issues complete'
  );
}

async function importOneIssue(
  forum: ForumChannel,
  cog: CogChannel,
  issue: GhIssue,
  labelToTag: Map<string, string>,
  deps: TicketsModuleDeps
): Promise<void> {
  const summary = extractPlayerSummary(issue.body);
  const stub = summary
    ? `Imported from GitHub: ${issue.html_url}\n\n> ${summary}`
    : `Imported from GitHub: ${issue.html_url}`;

  const labels = labelNames(issue);
  const labelTagIds = labels
    .map((name) => labelToTag.get(name))
    .filter((id): id is string => Boolean(id));

  // Player posts get forced to pick a forum tag; programmatic creates don't.
  // Fall back to the configured default so imported issues aren't tagless.
  const typeTagIds =
    labelTagIds.length > 0
      ? labelTagIds
      : cog.defaultTypeTagId
      ? [cog.defaultTypeTagId]
      : [];

  const statusKey = resolveStatusKey(
    {
      state: issue.state,
      state_reason: issue.state_reason ?? null,
      labels: labels.map((name) => ({ name })),
    },
    cog.statusTagMap
  );
  const statusTagId = cog.statusTagMap[statusKey];

  const appliedTags = [
    ...new Set([...typeTagIds, ...(statusTagId ? [statusTagId] : [])]),
  ].slice(0, DISCORD_MAX_APPLIED_TAGS);

  const name = truncate(
    `[${cog.cogIdPrefix}-${issue.number}] ${issue.title}`,
    DISCORD_MAX_THREAD_NAME
  );

  const created = await forum.threads.create({
    name,
    message: { content: stub },
    appliedTags,
  });

  await deps.db.insert(threadIssueMap).values({
    discordThreadId: created.id,
    discordChannelId: forum.id,
    discordGuildId: forum.guildId,
    githubOwner: cog.githubOwner,
    githubRepo: cog.githubRepo,
    githubIssueNumber: issue.number,
    githubIssueNodeId: issue.node_id,
  });

  if (issue.state === 'closed') {
    await created.setArchived(true).catch((err) => {
      deps.log.warn(
        { err, threadId: created.id, issueNumber: issue.number },
        'cog-import-issues: could not archive imported closed thread'
      );
    });
  }
}
