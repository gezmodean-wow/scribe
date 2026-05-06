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
  thread: ThreadChannel
): Promise<Message | null> {
  return thread
    .send({
      content: CONTROL_MESSAGE_HEADER,
      components: [buildTicketActionsRow()],
    })
    .catch(() => null);
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

  let currentState: string;
  try {
    const { data } = await deps.github.rest.issues.get({
      owner: link.githubOwner,
      repo: link.githubRepo,
      issue_number: link.githubIssueNumber,
    });
    currentState = data.state;
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

  if (currentState === 'closed') {
    await interaction.editReply(
      `Issue **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}** is already closed.`
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

  let currentState: string;
  try {
    const { data } = await deps.github.rest.issues.get({
      owner: link.githubOwner,
      repo: link.githubRepo,
      issue_number: link.githubIssueNumber,
    });
    currentState = data.state;
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

  if (currentState === 'open') {
    await interaction.editReply(
      `Issue **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}** is already open.`
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
