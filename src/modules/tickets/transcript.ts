import {
  type ChatInputCommandInteraction,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type ThreadChannel,
  type User,
} from 'discord.js';
import { asc, eq } from 'drizzle-orm';
import {
  type ThreadIssueMap,
  threadIssueMap,
  type ThreadTranscript,
  threadTranscripts,
} from '../../core/db/schema.js';
import type { TicketsModuleDeps } from './index.js';
import { formatDiscordForGithub } from './mirror.js';

const PROMOTE_EMOJI = '🔁';
const PROMOTED_ACK_EMOJI = '✅';
// Headroom under GitHub's ~65k char comment limit; transcripts split into
// multiple comments at this boundary.
const TRANSCRIPT_CHUNK_BYTES = 60_000;

export function registerTranscriptModule(deps: TicketsModuleDeps) {
  deps.discord.on('messageCreate', (message) => {
    void onMessageCreate(message, deps).catch((err) => {
      deps.log.error(
        { err, messageId: message.id },
        'transcript: messageCreate failed'
      );
    });
  });

  deps.discord.on('messageReactionAdd', (reaction, user) => {
    void onReactionAdd(reaction, user, deps).catch((err) => {
      deps.log.error(
        { err, messageId: reaction.message.id },
        'transcript: messageReactionAdd failed'
      );
    });
  });
}

async function onMessageCreate(
  message: Message,
  deps: TicketsModuleDeps
): Promise<void> {
  if (message.author.bot) return;
  if (!message.inGuild()) return;
  if (!message.channel.isThread()) return;

  const thread = message.channel as ThreadChannel;
  const link = await findThreadLink(thread.id, deps);
  if (!link) return;

  await persistTranscriptRow(message, deps);

  if (message.attachments.size > 0) {
    await promoteMessage(message, link, 'auto', deps).catch((err) => {
      deps.log.warn(
        { err, messageId: message.id },
        'transcript: auto-promote on attachment failed'
      );
    });
  }
}

async function onReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  deps: TicketsModuleDeps
): Promise<void> {
  if (reaction.emoji.name !== PROMOTE_EMOJI) return;

  const fullUser = user.partial ? await user.fetch() : user;
  if (fullUser.bot) return;

  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  const message = fullReaction.message.partial
    ? await fullReaction.message.fetch()
    : fullReaction.message;
  if (!message.inGuild()) return;
  if (!message.channel.isThread()) return;

  const member = await message.guild.members
    .fetch(fullUser.id)
    .catch(() => null);
  if (!member) return;
  const memberRoleIds = Array.from(member.roles.cache.keys());
  const isStaff = deps.config.discord.staffRoleIds.some((id) =>
    memberRoleIds.includes(id)
  );
  if (!isStaff) return;

  const thread = message.channel as ThreadChannel;
  const link = await findThreadLink(thread.id, deps);
  if (!link) return;

  await persistTranscriptRow(message, deps);
  await promoteMessage(message, link, fullUser.id, deps).catch((err) => {
    deps.log.warn(
      { err, messageId: message.id },
      'transcript: manual promote via 🔁 failed'
    );
  });
}

async function findThreadLink(
  threadId: string,
  deps: TicketsModuleDeps
): Promise<ThreadIssueMap | null> {
  const [row] = await deps.db
    .select()
    .from(threadIssueMap)
    .where(eq(threadIssueMap.discordThreadId, threadId))
    .limit(1);
  return row ?? null;
}

async function persistTranscriptRow(
  message: Message,
  deps: TicketsModuleDeps
): Promise<void> {
  await deps.db
    .insert(threadTranscripts)
    .values({
      discordThreadId: message.channelId,
      discordMessageId: message.id,
      discordAuthorId: message.author.id,
      discordAuthorName: message.author.username,
      content: message.content,
      attachmentsJson: [...message.attachments.values()].map((a) => ({
        id: a.id,
        url: a.url,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
      })),
      createdAt: message.createdAt,
    })
    .onConflictDoNothing();
}

async function promoteMessage(
  message: Message,
  link: ThreadIssueMap,
  promotedBy: string,
  deps: TicketsModuleDeps
): Promise<void> {
  const [existing] = await deps.db
    .select()
    .from(threadTranscripts)
    .where(eq(threadTranscripts.discordMessageId, message.id))
    .limit(1);
  if (!existing) return;
  if (existing.promotedAt) {
    await message.react(PROMOTED_ACK_EMOJI).catch(() => {});
    return;
  }

  const body = await formatDiscordForGithub(message, deps.log);
  const { data: comment } = await deps.github.rest.issues.createComment({
    owner: link.githubOwner,
    repo: link.githubRepo,
    issue_number: link.githubIssueNumber,
    body,
  });

  await deps.db
    .update(threadTranscripts)
    .set({
      promotedAt: new Date(),
      promotedBy,
      githubCommentId: String(comment.id),
    })
    .where(eq(threadTranscripts.discordMessageId, message.id));

  await message.react(PROMOTED_ACK_EMOJI).catch(() => {});

  deps.log.info(
    {
      messageId: message.id,
      issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}`,
      promotedBy,
    },
    'transcript: message promoted to GitHub'
  );
}

export async function handleTranscriptCommand(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({
      content: 'Use `/transcript` inside a tracked forum thread.',
      ephemeral: true,
    });
    return;
  }

  const thread = interaction.channel as ThreadChannel;
  const link = await findThreadLink(thread.id, deps);
  if (!link) {
    await interaction.reply({
      content: 'This thread isn\'t tracked. Run `/track` first.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const rows = await deps.db
    .select()
    .from(threadTranscripts)
    .where(eq(threadTranscripts.discordThreadId, thread.id))
    .orderBy(asc(threadTranscripts.createdAt));

  if (rows.length === 0) {
    await interaction.editReply(
      'No transcript rows for this thread (may predate the transcript feature).'
    );
    return;
  }

  const lines = rows.map(formatTranscriptLine);
  const chunks = chunkByBytes(lines, TRANSCRIPT_CHUNK_BYTES);

  for (let i = 0; i < chunks.length; i++) {
    const header =
      chunks.length === 1
        ? `**Discord transcript** (${rows.length} message(s))`
        : `**Discord transcript** part ${i + 1}/${chunks.length} (${rows.length} message(s) total)`;
    await deps.github.rest.issues.createComment({
      owner: link.githubOwner,
      repo: link.githubRepo,
      issue_number: link.githubIssueNumber,
      body: `${header}\n\n~~~text\n${chunks[i]}\n~~~`,
    });
  }

  await interaction.editReply(
    `Posted transcript to **${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}** (${chunks.length} comment(s), ${rows.length} message(s)).`
  );

  deps.log.info(
    {
      threadId: thread.id,
      issue: `${link.githubOwner}/${link.githubRepo}#${link.githubIssueNumber}`,
      messages: rows.length,
      chunks: chunks.length,
    },
    'transcript: posted to GitHub'
  );
}

function formatTranscriptLine(row: ThreadTranscript): string {
  const ts = row.createdAt.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const promotedTag = row.promotedAt ? ' [promoted]' : '';
  const content = row.content || '(no text)';
  const attachmentLines =
    row.attachmentsJson.length > 0
      ? '\n  ' +
        row.attachmentsJson
          .map((a) => `attachment: ${a.name ?? '(unnamed)'} ${a.url}`)
          .join('\n  ')
      : '';
  return `[${ts}] ${row.discordAuthorName}${promotedTag}: ${content}${attachmentLines}`;
}

function chunkByBytes(lines: string[], maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? current + '\n' + line : line;
    if (next.length > maxBytes && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
