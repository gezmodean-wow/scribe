import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Message,
  type ThreadChannel,
} from 'discord.js';
import { eq } from 'drizzle-orm';
import { threadIssueMap } from '../../core/db/schema.js';
import { findCogForChannel, type CogChannel } from './channels.js';
import { applyStatusTag, resolveStatusKey } from './status.js';
import type { TicketsModuleDeps } from './index.js';

const ACTION_PREFIX = 'ticket-action:';
const ACTION_CLOSE_COMPLETED = `${ACTION_PREFIX}close-completed`;
const ACTION_CLOSE_NOT_PLANNED = `${ACTION_PREFIX}close-not_planned`;
const ACTION_CLOSE_DUPLICATE = `${ACTION_PREFIX}close-duplicate`;
const ACTION_REOPEN = `${ACTION_PREFIX}reopen`;

const CONTROL_MESSAGE_HEADER = '**Ticket actions** _(admin only)_';

export function isTicketActionId(customId: string): boolean {
  return customId.startsWith(ACTION_PREFIX);
}

// Fixed 4-button row regardless of current issue state. Clicking a button
// that contradicts current state (e.g. Reopen on an already-open issue)
// short-circuits with an ephemeral reply rather than failing — keeps the
// row usable across the full lifecycle without tracking message ids per
// state change.
export function buildTicketActionsRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(ACTION_CLOSE_COMPLETED)
      .setLabel('Close as fixed')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(ACTION_CLOSE_NOT_PLANNED)
      .setLabel("Close as won't fix")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ACTION_CLOSE_DUPLICATE)
      .setLabel('Close as duplicate')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ACTION_REOPEN)
      .setLabel('Reopen')
      .setStyle(ButtonStyle.Primary)
  );
}

export async function postTicketActionsMessage(
  thread: ThreadChannel,
  log: TicketsModuleDeps['log']
): Promise<Message | null> {
  return thread
    .send({
      content: CONTROL_MESSAGE_HEADER,
      components: [buildTicketActionsRow()],
    })
    .catch((err) => {
      log.warn(
        { err, threadId: thread.id, threadName: thread.name },
        'could not post ticket-actions row to thread'
      );
      return null;
    });
}

// Returns true when the thread already has a ticket-actions message.
// Detection scans recent messages for any component carrying our prefix —
// content marker is fragile (we might rename the header), custom IDs are
// stable contracts we own.
export async function threadHasTicketActions(
  thread: ThreadChannel
): Promise<boolean> {
  const recent = await thread.messages.fetch({ limit: 50 }).catch(() => null);
  if (!recent) return false;
  for (const msg of recent.values()) {
    for (const row of msg.components ?? []) {
      // Discord.js v14 ActionRow exposes components; each has a customId
      // (for buttons) or null (for non-button components).
      for (const comp of (row as unknown as { components?: Array<{ customId?: string | null }> }).components ?? []) {
        if (comp.customId && isTicketActionId(comp.customId)) return true;
      }
    }
  }
  return false;
}

export async function handleTicketActionButton(
  interaction: ButtonInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isThread()) {
    await interaction.reply({
      content: 'Ticket actions only work inside a forum thread.',
      ephemeral: true,
    });
    return;
  }
  const thread = channel as ThreadChannel;

  const [link] = await deps.db
    .select()
    .from(threadIssueMap)
    .where(eq(threadIssueMap.discordThreadId, thread.id))
    .limit(1);
  if (!link) {
    await interaction.reply({
      content:
        'This thread is not linked to a GitHub issue. Run `/track` or `/cog-backfill` first.',
      ephemeral: true,
    });
    return;
  }

  const id = interaction.customId;
  if (id === ACTION_REOPEN) {
    await reopenIssue(interaction, link, deps);
    return;
  }
  const stateReason = parseCloseReason(id);
  if (!stateReason) {
    // Unknown action prefix — should never happen if isTicketActionId gated
    // upstream, but bail quietly rather than throwing.
    await interaction.reply({
      content: 'Unknown ticket action.',
      ephemeral: true,
    });
    return;
  }
  await closeIssue(interaction, link, stateReason, deps);
}

function parseCloseReason(
  customId: string
): 'completed' | 'not_planned' | 'duplicate' | null {
  if (customId === ACTION_CLOSE_COMPLETED) return 'completed';
  if (customId === ACTION_CLOSE_NOT_PLANNED) return 'not_planned';
  if (customId === ACTION_CLOSE_DUPLICATE) return 'duplicate';
  return null;
}

async function closeIssue(
  interaction: ButtonInteraction,
  link: {
    githubOwner: string;
    githubRepo: string;
    githubIssueNumber: number;
    githubIssueNodeId: string;
  },
  stateReason: 'completed' | 'not_planned' | 'duplicate',
  deps: TicketsModuleDeps
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const thread = interaction.channel as ThreadChannel;

  let issueData: {
    state: string;
    state_reason?: string | null;
    labels?: Array<string | { name?: string | null }>;
  };
  try {
    const { data } = await deps.github.rest.issues.get({
      owner: link.githubOwner,
      repo: link.githubRepo,
      issue_number: link.githubIssueNumber,
    });
    issueData = data;
  } catch (err) {
    deps.log.warn(
      { err, issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}` },
      'ticket-action close: could not fetch issue state'
    );
    await interaction.editReply(
      'Could not reach GitHub to check the issue. Try again in a moment.'
    );
    return;
  }

  if (issueData.state === 'closed') {
    const synced = await syncClosedThreadState(thread, link, issueData, deps);
    await interaction.editReply(
      synced
        ? `Issue **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}** was already closed on GitHub — synced thread (status tag + archive).`
        : `Issue **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}** is already closed.`
    );
    return;
  }

  // GraphQL closeIssue mutation is the only API that supports DUPLICATE as
  // a state_reason; REST update tops out at completed/not_planned. Using
  // GraphQL for all three keeps one path. The webhook fired afterward
  // reflects the chosen state_reason exactly.
  const graphqlStateReason = stateReason.toUpperCase() as
    | 'COMPLETED'
    | 'NOT_PLANNED'
    | 'DUPLICATE';
  try {
    await deps.github.graphql(
      `mutation CloseIssue($issueId: ID!, $stateReason: IssueClosedStateReason!) {
        closeIssue(input: { issueId: $issueId, stateReason: $stateReason }) {
          issue { number state stateReason }
        }
      }`,
      {
        issueId: link.githubIssueNodeId,
        stateReason: graphqlStateReason,
      }
    );
  } catch (err) {
    deps.log.error(
      {
        err,
        issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}`,
        stateReason,
      },
      'ticket-action close: GitHub GraphQL call failed'
    );
    await interaction.editReply(
      'GitHub rejected the close request. Check the logs.'
    );
    return;
  }

  // Tag application + thread archive happen via the existing issues.closed
  // webhook handler (mirror.ts:announceIssueClosed). The reply just confirms
  // the click.
  await interaction.editReply(
    `Closed **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}** as \`${stateReason}\`.`
  );
  deps.log.info(
    {
      issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}`,
      stateReason,
      actor: interaction.user.id,
    },
    'ticket-action: closed via admin button'
  );
}

async function reopenIssue(
  interaction: ButtonInteraction,
  link: { githubOwner: string; githubRepo: string; githubIssueNumber: number },
  deps: TicketsModuleDeps
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const thread = interaction.channel as ThreadChannel;

  let issueData: {
    state: string;
    state_reason?: string | null;
    labels?: Array<string | { name?: string | null }>;
  };
  try {
    const { data } = await deps.github.rest.issues.get({
      owner: link.githubOwner,
      repo: link.githubRepo,
      issue_number: link.githubIssueNumber,
    });
    issueData = data;
  } catch (err) {
    deps.log.warn(
      { err, issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}` },
      'ticket-action reopen: could not fetch issue state'
    );
    await interaction.editReply(
      'Could not reach GitHub to check the issue. Try again in a moment.'
    );
    return;
  }

  if (issueData.state === 'open') {
    const synced = await syncOpenThreadState(thread, link, issueData, deps);
    await interaction.editReply(
      synced
        ? `Issue **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}** was already open on GitHub — synced thread (unarchived + status tag).`
        : `Issue **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}** is already open.`
    );
    return;
  }

  try {
    await deps.github.rest.issues.update({
      owner: link.githubOwner,
      repo: link.githubRepo,
      issue_number: link.githubIssueNumber,
      state: 'open',
    });
  } catch (err) {
    deps.log.error(
      { err, issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}` },
      'ticket-action reopen: GitHub API call failed'
    );
    await interaction.editReply(
      'GitHub rejected the reopen request. Check the logs.'
    );
    return;
  }

  await interaction.editReply(
    `Reopened **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}**.`
  );
  deps.log.info(
    {
      issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}`,
      actor: interaction.user.id,
    },
    'ticket-action: reopened via admin button'
  );
}

// When an admin clicks Close on an issue that's already closed on GitHub
// (e.g. closed via release-publish, closed directly on GitHub, or original
// `issues.closed` webhook missed), the Discord thread can be stranded with
// stale state. Re-derive the correct status tag from current issue data and
// archive — but skip the close announcement to avoid duplicating one that
// might already be in the thread from the original close.
async function syncClosedThreadState(
  thread: ThreadChannel,
  link: { githubOwner: string; githubRepo: string; githubIssueNumber: number },
  issue: {
    state: string;
    state_reason?: string | null;
    labels?: Array<string | { name?: string | null }>;
  },
  deps: TicketsModuleDeps
): Promise<boolean> {
  const cog = await findCogForChannel(deps.db, thread.parentId ?? '');
  if (!cog) return false;

  const labels = normalizeLabels(issue.labels);
  const statusKey = resolveStatusKey(
    {
      state: 'closed',
      state_reason: issue.state_reason ?? null,
      labels,
    },
    cog.statusTagMap
  );

  let tagApplied = false;
  try {
    await applyStatusTag(thread, cog, statusKey);
    tagApplied = true;
  } catch (err) {
    deps.log.warn(
      { err, threadId: thread.id, statusKey },
      'sync-closed: could not apply status tag'
    );
  }

  let archived = false;
  if (!thread.archived) {
    try {
      await thread.setArchived(true);
      archived = true;
    } catch (err) {
      deps.log.warn(
        { err, threadId: thread.id },
        'sync-closed: could not archive thread'
      );
    }
  } else {
    archived = true;
  }

  const synced = tagApplied || archived;
  if (synced) {
    deps.log.info(
      {
        issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}`,
        threadId: thread.id,
        statusKey,
      },
      'ticket-action: synced thread state for already-closed issue'
    );
  }
  return synced;
}

// Symmetric to syncClosedThreadState — used when admin clicks Reopen on an
// issue that's already open on GitHub (e.g. reopened directly on GitHub and
// the webhook was missed). Unarchive + re-derive status tag.
async function syncOpenThreadState(
  thread: ThreadChannel,
  link: { githubOwner: string; githubRepo: string; githubIssueNumber: number },
  issue: {
    state: string;
    state_reason?: string | null;
    labels?: Array<string | { name?: string | null }>;
  },
  deps: TicketsModuleDeps
): Promise<boolean> {
  const cog = await findCogForChannel(deps.db, thread.parentId ?? '');
  if (!cog) return false;

  const labels = normalizeLabels(issue.labels);
  const statusKey = resolveStatusKey(
    { state: 'open', state_reason: null, labels },
    cog.statusTagMap
  );

  let unarchived = false;
  if (thread.archived) {
    try {
      await thread.setArchived(false);
      unarchived = true;
    } catch (err) {
      deps.log.warn(
        { err, threadId: thread.id },
        'sync-open: could not unarchive thread'
      );
    }
  }

  let tagApplied = false;
  try {
    await applyStatusTag(thread, cog, statusKey);
    tagApplied = true;
  } catch (err) {
    deps.log.warn(
      { err, threadId: thread.id, statusKey },
      'sync-open: could not apply status tag'
    );
  }

  const synced = unarchived || tagApplied;
  if (synced) {
    deps.log.info(
      {
        issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}`,
        threadId: thread.id,
        statusKey,
      },
      'ticket-action: synced thread state for already-open issue'
    );
  }
  return synced;
}

// REST issues.get returns labels as either string names or objects with
// `name`. resolveStatusKey expects the object form.
function normalizeLabels(
  raw: Array<string | { name?: string | null }> | undefined
): Array<{ name: string }> {
  if (!raw) return [];
  const out: Array<{ name: string }> = [];
  for (const l of raw) {
    if (typeof l === 'string') {
      out.push({ name: l });
    } else if (l?.name) {
      out.push({ name: l.name });
    }
  }
  return out;
}
