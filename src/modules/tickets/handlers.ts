import {
  type AutocompleteInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type Message,
  type ThreadChannel,
} from 'discord.js';
import { eq } from 'drizzle-orm';
import { threadIssueMap } from '../../core/db/schema.js';
import {
  findCogForChannel,
  linkChannel,
  listChannels,
  setStatusMapping,
  setTagMapping,
  unlinkChannel,
  unsetStatusMapping,
  unsetTagMapping,
  type CogChannel,
} from './channels.js';
import type { TicketsModuleDeps } from './index.js';
import {
  applyStatusTag,
  resolveStatusKey,
  STATUS_KEYS,
  type StatusKey,
} from './status.js';

export async function handleTrack(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const { db, github, log } = deps;
  const channel = interaction.channel;

  if (!channel?.isThread()) {
    await interaction.reply({
      content: 'Use `/track` inside a forum thread.',
      ephemeral: true,
    });
    return;
  }

  const thread = channel as ThreadChannel;
  const parentId = thread.parentId;
  if (!parentId) {
    await interaction.reply({
      content: 'This thread has no parent channel.',
      ephemeral: true,
    });
    return;
  }

  const cog = await findCogForChannel(db, parentId);
  if (!cog) {
    await interaction.reply({
      content:
        'This forum channel is not linked to a cog repository. Run `/cog-link` first.',
      ephemeral: true,
    });
    return;
  }

  const existing = await db
    .select()
    .from(threadIssueMap)
    .where(eq(threadIssueMap.discordThreadId, thread.id))
    .limit(1);
  if (existing.length > 0) {
    const row = existing[0]!;
    await interaction.reply({
      content: `Already tracked as **${row.githubOwner}/${row.githubRepo}#${row.githubIssueNumber}**.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const starter = await thread.fetchStarterMessage().catch(() => null);
  const body = buildIssueBody(starter, thread, interaction.guildId);

  const labels = thread.appliedTags
    .map((tagId) => cog.tagLabelMap[tagId])
    .filter((label): label is string => Boolean(label));

  const { data: issue } = await github.rest.issues.create({
    owner: cog.githubOwner,
    repo: cog.githubRepo,
    title: thread.name,
    body,
    ...(labels.length > 0 ? { labels } : {}),
  });

  await db.insert(threadIssueMap).values({
    discordThreadId: thread.id,
    discordChannelId: parentId,
    discordGuildId: interaction.guildId ?? '',
    githubOwner: cog.githubOwner,
    githubRepo: cog.githubRepo,
    githubIssueNumber: issue.number,
    githubIssueNodeId: issue.node_id,
  });

  await renameThread(thread, cog, issue.number, log);

  const initialStatusKey = resolveStatusKey(
    {
      state: 'open',
      state_reason: null,
      labels: labels.map((name) => ({ name })),
    },
    cog.statusTagMap
  );
  await applyStatusTag(thread, cog, initialStatusKey).catch((err) => {
    log.warn(
      { err, threadId: thread.id },
      'could not apply initial status tag'
    );
  });

  await interaction.editReply(
    `Tracked as **${cog.githubOwner}/${cog.githubRepo}#${issue.number}**\n${issue.html_url}`
  );

  log.info(
    {
      threadId: thread.id,
      issue: `${cog.githubOwner}/${cog.githubRepo}#${issue.number}`,
    },
    'thread tracked'
  );
}

export async function handleCogLink(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const owner = interaction.options.getString('owner', true);
  const repo = interaction.options.getString('repo', true);
  const prefix = interaction.options.getString('prefix', true);

  if (channel.type !== ChannelType.GuildForum) {
    await interaction.reply({
      content: 'Pick a forum channel.',
      ephemeral: true,
    });
    return;
  }
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command must be run in a server.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  await linkChannel(deps.db, {
    discordChannelId: channel.id,
    discordGuildId: interaction.guildId,
    githubOwner: owner,
    githubRepo: repo,
    cogIdPrefix: prefix,
  });

  await interaction.editReply(
    `Linked <#${channel.id}> → **${owner}/${repo}** (prefix \`${prefix}\`)`
  );
}

export async function handleCogUnlink(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);

  await interaction.deferReply({ ephemeral: true });

  const row = await unlinkChannel(deps.db, channel.id);
  if (!row) {
    await interaction.editReply(`<#${channel.id}> wasn't linked.`);
    return;
  }
  await interaction.editReply(
    `Unlinked <#${channel.id}> (was **${row.githubOwner}/${row.githubRepo}**).`
  );
}

export async function handleCogList(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  await interaction.deferReply({ ephemeral: true });
  const rows = await listChannels(deps.db);

  if (rows.length === 0) {
    await interaction.editReply('No channels linked yet. Use `/cog-link`.');
    return;
  }

  const lines = rows.map(
    (r) =>
      `• <#${r.discordChannelId}> → **${r.githubOwner}/${r.githubRepo}** (\`${r.cogIdPrefix}\`)`
  );
  await interaction.editReply(lines.join('\n'));
}

export async function handleCogTagSet(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const tagId = interaction.options.getString('tag', true);
  const label = interaction.options.getString('label', true);

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

  const forum = (await deps.discord.channels
    .fetch(channel.id)
    .catch(() => null)) as ForumChannel | null;
  const tag = forum?.availableTags.find((t) => t.id === tagId);
  if (!tag) {
    await interaction.editReply(
      'That tag isn\'t on this forum. Use autocomplete to pick a valid one.'
    );
    return;
  }

  await setTagMapping(deps.db, channel.id, tagId, label);

  await interaction.editReply(
    `Mapped tag \`${tag.name}\` → label \`${label}\` for <#${channel.id}>.`
  );
}

export async function handleCogTagUnset(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const tagId = interaction.options.getString('tag', true);

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
    await interaction.editReply('This channel isn\'t linked.');
    return;
  }
  if (!(tagId in cog.tagLabelMap)) {
    await interaction.editReply('That tag has no mapping.');
    return;
  }

  await unsetTagMapping(deps.db, channel.id, tagId);
  await interaction.editReply('Mapping removed.');
}

export async function handleCogTagList(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);

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
    await interaction.editReply('This channel isn\'t linked.');
    return;
  }

  const entries = Object.entries(cog.tagLabelMap);
  if (entries.length === 0) {
    await interaction.editReply('No tag mappings yet. Use `/cog-tag-set`.');
    return;
  }

  const forum = (await deps.discord.channels
    .fetch(channel.id)
    .catch(() => null)) as ForumChannel | null;
  const tagNameById = new Map<string, string>();
  if (forum) {
    for (const t of forum.availableTags) tagNameById.set(t.id, t.name);
  }

  const lines = entries.map(([tagId, label]) => {
    const name = tagNameById.get(tagId) ?? `(deleted tag ${tagId})`;
    return `• \`${name}\` → \`${label}\``;
  });

  await interaction.editReply(lines.join('\n'));
}

export async function handleCogStatusSet(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const statusKey = interaction.options.getString('status', true) as StatusKey;
  const tagId = interaction.options.getString('tag', true);

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

  const forum = (await deps.discord.channels
    .fetch(channel.id)
    .catch(() => null)) as ForumChannel | null;
  const tag = forum?.availableTags.find((t) => t.id === tagId);
  if (!tag) {
    await interaction.editReply('That tag isn\'t on this forum.');
    return;
  }

  await setStatusMapping(deps.db, channel.id, statusKey, tagId);

  await interaction.editReply(
    `\`${statusKey}\` → \`${tag.name}\` on <#${channel.id}>.`
  );
}

export async function handleCogStatusUnset(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const statusKey = interaction.options.getString('status', true);

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
    await interaction.editReply('This channel isn\'t linked.');
    return;
  }
  if (!(statusKey in cog.statusTagMap)) {
    await interaction.editReply('That status has no mapping.');
    return;
  }

  await unsetStatusMapping(deps.db, channel.id, statusKey);
  await interaction.editReply(`Removed \`${statusKey}\` mapping.`);
}

export async function handleCogStatusList(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);

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
    await interaction.editReply('This channel isn\'t linked.');
    return;
  }

  const stateKeys = STATUS_KEYS.filter((key) => key in cog.statusTagMap);
  const labelKeys = Object.keys(cog.statusTagMap).filter((k) =>
    k.startsWith('label:')
  );

  if (stateKeys.length === 0 && labelKeys.length === 0) {
    await interaction.editReply('No status mappings yet.');
    return;
  }

  const forum = (await deps.discord.channels
    .fetch(channel.id)
    .catch(() => null)) as ForumChannel | null;
  const tagNameById = new Map<string, string>();
  if (forum) for (const t of forum.availableTags) tagNameById.set(t.id, t.name);

  const renderLine = (key: string) => {
    const tagId = cog.statusTagMap[key]!;
    const name = tagNameById.get(tagId) ?? `(deleted tag ${tagId})`;
    return `  • \`${key}\` → \`${name}\``;
  };

  const sections: string[] = [];
  if (stateKeys.length > 0) {
    sections.push(
      '**State mappings:**\n' + stateKeys.map(renderLine).join('\n')
    );
  }
  if (labelKeys.length > 0) {
    sections.push(
      '**Label mappings** (priority over state):\n' +
        labelKeys.map(renderLine).join('\n')
    );
  }

  await interaction.editReply(sections.join('\n\n'));
}

export async function handleCogLabelSet(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const labelName = interaction.options.getString('label', true);
  const tagId = interaction.options.getString('tag', true);

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

  const forum = (await deps.discord.channels
    .fetch(channel.id)
    .catch(() => null)) as ForumChannel | null;
  const tag = forum?.availableTags.find((t) => t.id === tagId);
  if (!tag) {
    await interaction.editReply('That tag isn\'t on this forum.');
    return;
  }

  const statusKey = `label:${labelName}`;
  await setStatusMapping(deps.db, channel.id, statusKey, tagId);

  await interaction.editReply(
    `Label \`${labelName}\` → tag \`${tag.name}\` on <#${channel.id}>.`
  );
}

export async function handleCogLabelUnset(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const labelName = interaction.options.getString('label', true);

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
    await interaction.editReply('This channel isn\'t linked.');
    return;
  }

  const statusKey = `label:${labelName}`;
  if (!(statusKey in cog.statusTagMap)) {
    await interaction.editReply('That label has no mapping.');
    return;
  }

  await unsetStatusMapping(deps.db, channel.id, statusKey);
  await interaction.editReply(`Removed \`${labelName}\` mapping.`);
}

export async function handleTagAutocomplete(
  interaction: AutocompleteInteraction,
  _deps: TicketsModuleDeps
) {
  const channelId = interaction.options.get('channel')?.value as
    | string
    | undefined;
  if (!channelId) {
    await interaction.respond([]);
    return;
  }

  const channel = await interaction.client.channels
    .fetch(channelId)
    .catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused().toLowerCase();
  const forum = channel as ForumChannel;
  const matches = forum.availableTags
    .filter((t) => t.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((t) => ({ name: t.name, value: t.id }));

  await interaction.respond(matches);
}

function buildIssueBody(
  starter: Message | null,
  thread: ThreadChannel,
  guildId: string | null
): string {
  const threadUrl = guildId
    ? `https://discord.com/channels/${guildId}/${thread.id}`
    : '(no guild id)';
  const author = thread.ownerId ? `<@${thread.ownerId}>` : 'unknown';
  const content = starter?.content?.trim() || '_(no starter message)_';

  const attachments =
    starter && starter.attachments.size > 0
      ? '\n\n' +
        [...starter.attachments.values()]
          .map((a) => `Attachment: ${a.url}`)
          .join('\n')
      : '';

  return [
    content + attachments,
    '',
    '---',
    `Filed from Discord thread: ${threadUrl}`,
    `Opened by: ${author}`,
  ].join('\n');
}

async function renameThread(
  thread: ThreadChannel,
  cog: CogChannel,
  issueNumber: number,
  log: TicketsModuleDeps['log']
) {
  const prefix = `[${cog.cogIdPrefix}-${issueNumber}] `;
  const MAX_THREAD_NAME = 100;
  const newName = (prefix + thread.name).slice(0, MAX_THREAD_NAME);
  try {
    await thread.setName(newName);
  } catch (err) {
    log.warn(
      { err, threadId: thread.id },
      'could not rename thread (missing Manage Threads permission?)'
    );
  }
}
