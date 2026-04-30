import type { Attachment, Message, ThreadChannel } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { threadIssueMap } from '../../core/db/schema.js';
import { findCogForChannel, type CogChannel } from './channels.js';
import type { TicketsModuleDeps } from './index.js';
import { extractPlayerSummary, extractPlayerUpdate } from './release-notes.js';
import { handleReleaseEvent } from './releases.js';
import { applyStatusTag, resolveStatusKey } from './status.js';

// Discord CDN URLs are signed with `ex=` epoch and expire; inlining preserves the evidence.
const TEXT_INLINE_CAP_BYTES = 64 * 1024;
const TEXT_INLINE_HEAD_BYTES = 32 * 1024;
const TEXT_INLINE_TAIL_BYTES = 32 * 1024;

const TEXT_INLINE_CONTENT_TYPES = new Set([
  'application/json',
  'application/yaml',
  'application/x-yaml',
]);
const TEXT_INLINE_FILENAME_RE = /\.(lua|log|txt)$/i;

function isTextLikeAttachment(att: Attachment): boolean {
  const ct = att.contentType?.toLowerCase().split(';')[0]?.trim() ?? '';
  if (ct.startsWith('text/')) return true;
  if (TEXT_INLINE_CONTENT_TYPES.has(ct)) return true;
  if (att.name && TEXT_INLINE_FILENAME_RE.test(att.name)) return true;
  return false;
}

function langHint(name: string | null): string {
  const n = (name ?? '').toLowerCase();
  if (n.endsWith('.lua')) return 'lua';
  if (n.endsWith('.json')) return 'json';
  if (n.endsWith('.yaml') || n.endsWith('.yml')) return 'yaml';
  return '';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

type FetchedText = {
  body: string;
  truncated: boolean;
  originalBytes: number;
};

async function fetchTextAttachment(att: Attachment): Promise<FetchedText> {
  const res = await fetch(att.url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${att.name ?? 'attachment'}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const originalBytes = buf.length;
  if (originalBytes <= TEXT_INLINE_CAP_BYTES) {
    return { body: buf.toString('utf8'), truncated: false, originalBytes };
  }
  const head = buf.subarray(0, TEXT_INLINE_HEAD_BYTES).toString('utf8');
  const tail = buf
    .subarray(originalBytes - TEXT_INLINE_TAIL_BYTES)
    .toString('utf8');
  const omitted =
    originalBytes - TEXT_INLINE_HEAD_BYTES - TEXT_INLINE_TAIL_BYTES;
  return {
    body: `${head}\n\n... [truncated ${formatBytes(omitted)}] ...\n\n${tail}`,
    truncated: true,
    originalBytes,
  };
}

export async function formatDiscordForGithub(
  message: Message,
  log: TicketsModuleDeps['log']
): Promise<string> {
  const header = `**${message.author.username}** (via Discord):`;
  const body = message.content || '_(no text content)_';

  const attachments = [...message.attachments.values()];
  const fetched = await Promise.all(
    attachments.map(async (att): Promise<FetchedText | 'skip' | 'error'> => {
      if (!isTextLikeAttachment(att)) return 'skip';
      try {
        return await fetchTextAttachment(att);
      } catch (err) {
        log.warn(
          { err, name: att.name, url: att.url },
          'failed to inline text attachment, falling back to link'
        );
        return 'error';
      }
    })
  );

  const lines: string[] = [header, '', body];

  for (const [i, att] of attachments.entries()) {
    const result = fetched[i]!;
    lines.push('');
    if (result === 'skip' || result === 'error') {
      lines.push(`Attachment: ${att.url}`);
      continue;
    }
    const lang = langHint(att.name);
    const sizeNote = `${formatBytes(result.originalBytes)}${result.truncated ? ', truncated' : ''}`;
    lines.push(
      `**Attachment:** \`${att.name ?? 'file'}\` (${sizeNote}) — [original](${att.url})`
    );
    // Tilde fence avoids collisions with backtick fences inside log output.
    lines.push('~~~' + lang);
    lines.push(result.body);
    lines.push('~~~');
  }

  return lines.join('\n');
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

  const update = extractPlayerUpdate(payload.comment.body);
  if (!update) {
    deps.log.debug(
      {
        issue: `${payload.repository.full_name}#${payload.issue.number}`,
        author: payload.comment.user.login,
      },
      'github comment has no `## Player update` block; not mirroring'
    );
    return;
  }

  const found = await findThreadAndCog(payload, deps);
  if (!found) return;
  const { thread } = found;

  const messages = formatGithubCommentForDiscord(payload, update);
  try {
    for (const content of messages) {
      await thread.send(content);
    }
    deps.log.info(
      {
        threadId: thread.id,
        issue: `${payload.repository.full_name}#${payload.issue.number}`,
        chunks: messages.length,
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
  const summary = extractPlayerSummary(payload.issue.body);
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

  // Archive after the announcement + tag update so the message lands and the
  // tag is visible before the thread drops out of the active list.
  await thread.setArchived(true).catch((err) => {
    deps.log.warn(
      { err, threadId: thread.id },
      'could not archive thread on close'
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

  // Unarchive first so the announcement + tag update apply visibly. Send
  // alone would auto-unarchive, but doing it explicitly surfaces permission
  // errors instead of silently hiding the rest of the work.
  if (thread.archived) {
    await thread.setArchived(false).catch((err) => {
      deps.log.warn(
        { err, threadId: thread.id },
        'could not unarchive thread on reopen'
      );
    });
  }

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

// Discord caps a single message at 2000 chars. Long player updates (multi-step
// instructions, code blocks, etc.) get chunked into consecutive messages so
// nothing is lost. Header lands on the first chunk only; continuations get a
// small `_(continued)_` marker so it's obvious they belong together.
const DISCORD_MESSAGE_CAP = 2000;
const CONTINUATION_MARKER = '_(continued)_';

function formatGithubCommentForDiscord(
  payload: IssueCommentPayload,
  update: string
): string[] {
  const header = `📢 **${payload.comment.user.login}** (via GitHub · ${payload.repository.full_name}#${payload.issue.number}):`;
  const firstCap = DISCORD_MESSAGE_CAP - header.length - 1;
  const restCap = DISCORD_MESSAGE_CAP - CONTINUATION_MARKER.length - 1;

  const parts = chunkForDiscord(update, firstCap, restCap);
  return parts.map((part, i) =>
    i === 0 ? `${header}\n${part}` : `${CONTINUATION_MARKER}\n${part}`
  );
}

// Split text into chunks that fit Discord's per-message cap, preferring to
// break at paragraph (\n\n), then line (\n), then word (space) boundaries
// before falling back to a hard cut.
export function chunkForDiscord(
  text: string,
  firstCap: number,
  restCap: number
): string[] {
  if (text.length <= firstCap) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let cap = firstCap;

  while (remaining.length > cap) {
    const split = pickSplit(remaining, cap);
    chunks.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).replace(/^\s+/, '');
    cap = restCap;
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function pickSplit(s: string, cap: number): number {
  // Require the split to land at least halfway through the chunk so a single
  // run-on paragraph still gets cut near the cap rather than near the start.
  const minSplit = Math.floor(cap / 2);
  for (const probe of ['\n\n', '\n', ' ']) {
    const at = s.lastIndexOf(probe, cap);
    if (at >= minSplit) return at + probe.length;
  }
  return cap;
}

function stateReasonSuffix(reason?: string | null): string {
  if (reason === 'not_planned') return ' (not planned)';
  if (reason === 'duplicate') return ' (duplicate)';
  return '';
}
