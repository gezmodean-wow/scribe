import type { Message, ThreadChannel } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { threadIssueMap } from '../../core/db/schema.js';
import { findCogForChannel, type CogChannel } from './channels.js';
import type { TicketsModuleDeps } from './index.js';
import { extractPlayerSummary } from './release-notes.js';
import { handleReleaseEvent } from './releases.js';
import { applyStatusTag, resolveStatusKey } from './status.js';

export function registerMirror(deps: TicketsModuleDeps) {
  deps.discord.on('messageCreate', (message) => {
    void mirrorDiscordToGithub(message, deps).catch((err) => {
      deps.log.error(
        { err, messageId: message.id },
        'discord → github mirror failed'
      );
    });
  });
}

async function mirrorDiscordToGithub(
  message: Message,
  deps: TicketsModuleDeps
) {
  if (message.author.bot) return;
  if (!message.inGuild()) return;
  if (!message.channel.isThread()) return;

  const thread = message.channel as ThreadChannel;
  const [row] = await deps.db
    .select()
    .from(threadIssueMap)
    .where(eq(threadIssueMap.discordThreadId, thread.id))
    .limit(1);
  if (!row) return;

  const body = formatDiscordForGithub(message);
  await deps.github.rest.issues.createComment({
    owner: row.githubOwner,
    repo: row.githubRepo,
    issue_number: row.githubIssueNumber,
    body,
  });
  deps.log.info(
    {
      threadId: thread.id,
      issue: `${row.githubOwner}/${row.githubRepo}#${row.githubIssueNumber}`,
    },
    'mirrored discord → github'
  );
}

function formatDiscordForGithub(message: Message): string {
  const attachments =
    message.attachments.size > 0
      ? '\n\n' +
        [...message.attachments.values()]
          .map((a) => `Attachment: ${a.url}`)
          .join('\n')
      : '';
  return `**${message.author.username}** (via Discord):\n\n${message.content || '_(no text content)_'}${attachments}`;
}

type IssueCommentPayload = {
  action: string;
  issue: { number: number };
  comment: { body: string; user: { login: string } };
  repository: { name: string; full_name: string; owner: { login: string } };
  sender?: { type?: string };
};

type IssuesPayload = {
  action: string;
  issue: {
    number: number;
    html_url: string;
    state: string;
    state_reason?: string | null;
    body?: string | null;
    labels?: Array<{ name: string }>;
  };
  repository: { name: string; full_name: string; owner: { login: string } };
};

export async function handleGithubMirror(
  event: string,
  payload: unknown,
  deps: TicketsModuleDeps
) {
  if (event === 'issue_comment') {
    const p = payload as IssueCommentPayload;
    if (p.action === 'created') {
      await mirrorIssueCommentToDiscord(p, deps);
    }
    return;
  }
  if (event === 'issues') {
    const p = payload as IssuesPayload;
    if (p.action === 'closed') await announceIssueClosed(p, deps);
    else if (p.action === 'reopened') await announceIssueReopened(p, deps);
    else if (p.action === 'labeled' || p.action === 'unlabeled') {
      await handleIssueLabelChange(p, deps);
    }
    return;
  }
  if (event === 'release') {
    await handleReleaseEvent(
      payload as Parameters<typeof handleReleaseEvent>[0],
      deps
    );
    return;
  }
}

async function mirrorIssueCommentToDiscord(
  payload: IssueCommentPayload,
  deps: TicketsModuleDeps
) {
  // Skip comments authored by any bot — most importantly our own app
  // posting a comment that originated from Discord. Without this guard
  // we'd mirror every such comment back to Discord and double-post.
  if (payload.sender?.type === 'Bot') return;

  const found = await findThreadAndCog(payload, deps);
  if (!found) return;
  const { thread } = found;

  const content = formatGithubCommentForDiscord(payload);
  try {
    await thread.send(content);
    deps.log.info(
      {
        threadId: thread.id,
        issue: `${payload.repository.full_name}#${payload.issue.number}`,
      },
      'mirrored github → discord'
    );
  } catch (err) {
    deps.log.warn(
      { err, threadId: thread.id },
      'could not send mirrored comment to thread'
    );
  }
}

async function announceIssueClosed(
  payload: IssuesPayload,
  deps: TicketsModuleDeps
) {
  const found = await findThreadAndCog(payload, deps);
  if (!found) return;
  const { thread, cog } = found;

  const reason = stateReasonSuffix(payload.issue.state_reason);
  const summary = extractPlayerSummary({ body: payload.issue.body });
  const summaryLine = summary ? `\n\n> ${summary}` : '';
  await thread
    .send(
      `✅ This issue has been closed${reason}.${summaryLine}\n${payload.issue.html_url}`
    )
    .catch((err) => {
      deps.log.warn(
        { err, threadId: thread.id },
        'could not announce close to thread'
      );
    });

  const remainingLabels = await stripStatusLabels(payload, cog, deps);

  const statusKey = resolveStatusKey(
    {
      state: 'closed',
      state_reason: payload.issue.state_reason ?? null,
      labels: remainingLabels,
    },
    cog.statusTagMap
  );
  await applyStatusTag(thread, cog, statusKey).catch((err) => {
    deps.log.warn(
      { err, threadId: thread.id, statusKey },
      'could not apply status tag'
    );
  });
}

async function stripStatusLabels(
  payload: IssuesPayload,
  cog: CogChannel,
  deps: TicketsModuleDeps
): Promise<Array<{ name: string }>> {
  const labels = payload.issue.labels ?? [];
  const statusLabelNames = new Set(
    Object.keys(cog.statusTagMap)
      .filter((k) => k.startsWith('label:'))
      .map((k) => k.slice('label:'.length))
  );
  const toRemove = labels.filter((l) => statusLabelNames.has(l.name));
  if (toRemove.length === 0) return labels;

  for (const label of toRemove) {
    await deps.github.rest.issues
      .removeLabel({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.issue.number,
        name: label.name,
      })
      .catch((err) => {
        deps.log.warn(
          {
            err,
            label: label.name,
            issue: `${payload.repository.full_name}#${payload.issue.number}`,
          },
          'could not strip status label on close'
        );
      });
  }
  return labels.filter((l) => !statusLabelNames.has(l.name));
}

async function announceIssueReopened(
  payload: IssuesPayload,
  deps: TicketsModuleDeps
) {
  const found = await findThreadAndCog(payload, deps);
  if (!found) return;
  const { thread, cog } = found;

  await thread.send('🔄 This issue has been reopened.').catch((err) => {
    deps.log.warn(
      { err, threadId: thread.id },
      'could not announce reopen to thread'
    );
  });

  const statusKey = resolveStatusKey(
    {
      state: 'open',
      state_reason: null,
      labels: payload.issue.labels,
    },
    cog.statusTagMap
  );
  await applyStatusTag(thread, cog, statusKey).catch((err) => {
    deps.log.warn(
      { err, threadId: thread.id, statusKey },
      'could not apply status tag on reopen'
    );
  });
}

async function handleIssueLabelChange(
  payload: IssuesPayload,
  deps: TicketsModuleDeps
) {
  const found = await findThreadAndCog(payload, deps);
  if (!found) return;
  const { thread, cog } = found;

  const statusKey = resolveStatusKey(
    {
      state: payload.issue.state,
      state_reason: payload.issue.state_reason ?? null,
      labels: payload.issue.labels,
    },
    cog.statusTagMap
  );
  await applyStatusTag(thread, cog, statusKey).catch((err) => {
    deps.log.warn(
      { err, threadId: thread.id, statusKey, action: payload.action },
      'could not apply status tag after label change'
    );
  });
}

async function findThreadAndCog(
  payload: {
    issue: { number: number };
    repository: { name: string; owner: { login: string } };
  },
  deps: TicketsModuleDeps
): Promise<{ thread: ThreadChannel; cog: CogChannel } | null> {
  const [row] = await deps.db
    .select()
    .from(threadIssueMap)
    .where(
      and(
        eq(threadIssueMap.githubOwner, payload.repository.owner.login),
        eq(threadIssueMap.githubRepo, payload.repository.name),
        eq(threadIssueMap.githubIssueNumber, payload.issue.number)
      )
    )
    .limit(1);
  if (!row) return null;

  const channel = await deps.discord.channels
    .fetch(row.discordThreadId)
    .catch(() => null);
  if (!channel?.isThread()) return null;

  const cog = await findCogForChannel(deps.db, row.discordChannelId);
  if (!cog) return null;

  return { thread: channel as ThreadChannel, cog };
}

function formatGithubCommentForDiscord(payload: IssueCommentPayload): string {
  const header = `💬 **${payload.comment.user.login}** (via GitHub · ${payload.repository.full_name}#${payload.issue.number}):`;
  const body = truncate(payload.comment.body, 1800);
  return `${header}\n${body}`;
}

function stateReasonSuffix(reason?: string | null): string {
  if (reason === 'not_planned') return ' (not planned)';
  if (reason === 'duplicate') return ' (duplicate)';
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
