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
  replaceMappings,
  setDefaultTypeTag,
  setReleaseConfig,
  setStatusMapping,
  setTagMapping,
  unlinkChannel,
  unsetDefaultTypeTag,
  unsetStatusMapping,
  unsetTagMapping,
  type CogChannel,
} from './channels.js';
import type { TicketsModuleDeps } from './index.js';
import { redraftRelease } from './releases.js';
import {
  applyStatusTag,
  resolveStatusKey,
  STATUS_KEYS,
  type StatusKey,
} from './status.js';
import {
  postTicketActionsMessage,
  threadHasTicketActions,
} from './ticket-actions.js';

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

  await postTicketActionsMessage(thread, log);

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
  const unmappedStateKeys = STATUS_KEYS.filter(
    (key) => !(key in cog.statusTagMap)
  );
  const labelKeys = Object.keys(cog.statusTagMap).filter((k) =>
    k.startsWith('label:')
  );

  if (stateKeys.length === 0 && labelKeys.length === 0) {
    await interaction.editReply(
      'No status mappings yet. Use `/cog-status-set` to start mapping.'
    );
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
  if (unmappedStateKeys.length > 0) {
    sections.push(
      '**Unmapped state keys:**\n' +
        unmappedStateKeys.map((k) => `  • \`${k}\``).join('\n')
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

export async function handleCogDefaultTypeSet(
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

  await setDefaultTypeTag(deps.db, channel.id, tagId);
  await interaction.editReply(
    `Default type tag for <#${channel.id}> → \`${tag.name}\`.`
  );
}

export async function handleCogDefaultTypeUnset(
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
  if (!cog.defaultTypeTagId) {
    await interaction.editReply('No default type tag is set.');
    return;
  }

  await unsetDefaultTypeTag(deps.db, channel.id);
  await interaction.editReply('Cleared default type tag.');
}

export async function handleCogCopyConfig(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const fromChannel = interaction.options.getChannel('from', true);
  const toChannel = interaction.options.getChannel('to', true);

  if (
    fromChannel.type !== ChannelType.GuildForum ||
    toChannel.type !== ChannelType.GuildForum
  ) {
    await interaction.reply({
      content: 'Both channels must be forum channels.',
      ephemeral: true,
    });
    return;
  }
  if (fromChannel.id === toChannel.id) {
    await interaction.reply({
      content: 'Source and destination are the same channel.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const fromCog = await findCogForChannel(deps.db, fromChannel.id);
  if (!fromCog) {
    await interaction.editReply(
      `<#${fromChannel.id}> isn't linked. Use \`/cog-link\` on the source first.`
    );
    return;
  }
  const toCog = await findCogForChannel(deps.db, toChannel.id);
  if (!toCog) {
    await interaction.editReply(
      `<#${toChannel.id}> isn't linked. Use \`/cog-link\` on the destination first.`
    );
    return;
  }

  const [fromForum, toForum] = (await Promise.all([
    deps.discord.channels.fetch(fromChannel.id).catch(() => null),
    deps.discord.channels.fetch(toChannel.id).catch(() => null),
  ])) as [ForumChannel | null, ForumChannel | null];
  if (!fromForum || !toForum) {
    await interaction.editReply('Could not fetch one of the forum channels.');
    return;
  }

  const fromNameById = new Map<string, string>();
  for (const t of fromForum.availableTags) fromNameById.set(t.id, t.name);
  const toIdByName = new Map<string, string>();
  for (const t of toForum.availableTags) toIdByName.set(t.name, t.id);

  const newTagLabelMap: Record<string, string> = {};
  const newStatusTagMap: Record<string, string> = {};
  const missingTagNames = new Set<string>();
  let copiedTagCount = 0;
  let copiedStateCount = 0;
  let copiedLabelCount = 0;

  for (const [srcTagId, label] of Object.entries(fromCog.tagLabelMap)) {
    const name = fromNameById.get(srcTagId);
    if (!name) continue;
    const destTagId = toIdByName.get(name);
    if (!destTagId) {
      missingTagNames.add(name);
      continue;
    }
    newTagLabelMap[destTagId] = label;
    copiedTagCount++;
  }

  for (const [statusKey, srcTagId] of Object.entries(fromCog.statusTagMap)) {
    const name = fromNameById.get(srcTagId);
    if (!name) continue;
    const destTagId = toIdByName.get(name);
    if (!destTagId) {
      missingTagNames.add(name);
      continue;
    }
    newStatusTagMap[statusKey] = destTagId;
    if (statusKey.startsWith('label:')) copiedLabelCount++;
    else copiedStateCount++;
  }

  await replaceMappings(
    deps.db,
    toChannel.id,
    newTagLabelMap,
    newStatusTagMap
  );

  const lines = [
    `Copied <#${fromChannel.id}> → <#${toChannel.id}>:`,
    `• ${copiedTagCount} intake tag mapping(s)`,
    `• ${copiedStateCount} state mapping(s)`,
    `• ${copiedLabelCount} label mapping(s)`,
  ];
  if (missingTagNames.size > 0) {
    lines.push(
      '',
      `**Skipped** — these tag names exist on the source but not on <#${toChannel.id}>:`,
      ...[...missingTagNames].map((n) => `  • \`${n}\``),
      '',
      'Add the missing tags to the destination forum and re-run this command to pick them up.'
    );
  }
  await interaction.editReply(lines.join('\n'));

  deps.log.info(
    {
      from: fromChannel.id,
      to: toChannel.id,
      copiedTagCount,
      copiedStateCount,
      copiedLabelCount,
      missingTagCount: missingTagNames.size,
    },
    'cog-copy-config complete'
  );
}

export async function handleCogBackfill(
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
    await interaction.editReply(
      'This channel isn\'t linked to a cog repository. Run `/cog-link` first.'
    );
    return;
  }

  const forum = (await deps.discord.channels
    .fetch(channel.id)
    .catch(() => null)) as ForumChannel | null;
  if (!forum) {
    await interaction.editReply('Could not fetch the forum channel.');
    return;
  }

  const threads = await fetchAllForumThreads(forum);
  const idPattern = new RegExp(
    `\\[${escapeRegex(cog.cogIdPrefix)}-(\\d+)\\]`,
    'i'
  );

  let created = 0;
  let alreadyMapped = 0;
  let noMatch = 0;
  let ghMissing = 0;
  let errors = 0;

  for (const thread of threads) {
    const existing = await deps.db
      .select()
      .from(threadIssueMap)
      .where(eq(threadIssueMap.discordThreadId, thread.id))
      .limit(1);
    if (existing.length > 0) {
      alreadyMapped++;
      continue;
    }

    const m = thread.name.match(idPattern);
    if (!m) {
      noMatch++;
      continue;
    }
    const issueNumber = Number.parseInt(m[1]!, 10);

    try {
      const { data: issue } = await deps.github.rest.issues.get({
        owner: cog.githubOwner,
        repo: cog.githubRepo,
        issue_number: issueNumber,
      });
      await deps.db.insert(threadIssueMap).values({
        discordThreadId: thread.id,
        discordChannelId: channel.id,
        discordGuildId: interaction.guildId ?? '',
        githubOwner: cog.githubOwner,
        githubRepo: cog.githubRepo,
        githubIssueNumber: issue.number,
        githubIssueNodeId: issue.node_id,
      });
      created++;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        ghMissing++;
      } else {
        errors++;
        deps.log.warn(
          { err, threadId: thread.id, issueNumber },
          'backfill: github lookup failed'
        );
      }
    }
  }

  const lines = [
    `Backfill complete for <#${channel.id}>:`,
    `• ${created} new mapping(s) created`,
    `• ${alreadyMapped} already mapped (skipped)`,
    `• ${noMatch} thread(s) had no \`[${cog.cogIdPrefix}-N]\` pattern`,
  ];
  if (ghMissing > 0) {
    lines.push(`• ${ghMissing} matched IDs but issue not found on GitHub`);
  }
  if (errors > 0) {
    lines.push(`• ${errors} error(s) — check logs`);
  }
  await interaction.editReply(lines.join('\n'));

  deps.log.info(
    {
      channelId: channel.id,
      cog: `${cog.githubOwner}/${cog.githubRepo}`,
      total: threads.length,
      created,
      alreadyMapped,
      noMatch,
      ghMissing,
      errors,
    },
    'cog-backfill complete'
  );
}

export async function handleCogBackfillDefaultType(
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
    await interaction.editReply(
      'This channel isn\'t linked to a cog repository. Run `/cog-link` first.'
    );
    return;
  }
  if (!cog.defaultTypeTagId) {
    await interaction.editReply(
      'No default type tag is set for this channel. Use `/cog-default-type-set` first.'
    );
    return;
  }

  const forum = (await deps.discord.channels
    .fetch(channel.id)
    .catch(() => null)) as ForumChannel | null;
  if (!forum) {
    await interaction.editReply('Could not fetch the forum channel.');
    return;
  }

  // A thread is "uncategorized" when none of its applied tags is a non-status
  // tag. Status tags are SCRIBE-managed (open/triaged/in_progress/closed:*),
  // so the test filters those out and asks: does anything else remain?
  const statusTagIds = new Set(Object.values(cog.statusTagMap));
  const defaultTagId = cog.defaultTypeTagId;
  // Verify the default tag still exists on the forum — Discord lets admins
  // delete tags out from under us, leaving stale ids in the cog config.
  const defaultExists = forum.availableTags.some((t) => t.id === defaultTagId);
  if (!defaultExists) {
    await interaction.editReply(
      'The configured default type tag no longer exists on this forum. Re-run `/cog-default-type-set` with a current tag.'
    );
    return;
  }

  const threads = await fetchAllForumThreads(forum);

  const DISCORD_MAX_APPLIED_TAGS = 5;
  let applied = 0;
  let alreadyTyped = 0;
  let alreadyHasDefault = 0;
  let atTagCap = 0;
  let errors = 0;

  for (const thread of threads) {
    const current = thread.appliedTags;
    const nonStatus = current.filter((id) => !statusTagIds.has(id));
    if (nonStatus.length > 0) {
      if (nonStatus.includes(defaultTagId)) alreadyHasDefault++;
      else alreadyTyped++;
      continue;
    }
    if (current.length >= DISCORD_MAX_APPLIED_TAGS) {
      atTagCap++;
      continue;
    }

    // Discord rejects setAppliedTags on archived threads with 50083 ("Thread
    // is archived"), so explicitly unarchive first. Re-archive afterwards
    // (including on failure) so we don't drag stale closed threads back into
    // the active list as a side effect of a tag fix-up.
    const wasArchived = thread.archived === true;
    try {
      if (wasArchived) {
        await thread.setArchived(false);
      }
      await thread.setAppliedTags(
        [...current, defaultTagId].slice(0, DISCORD_MAX_APPLIED_TAGS)
      );
      applied++;
    } catch (err) {
      errors++;
      deps.log.warn(
        { err, threadId: thread.id },
        'cog-backfill-default-type: failed on thread'
      );
    } finally {
      if (wasArchived && !thread.archived) {
        await thread.setArchived(true).catch((err) => {
          deps.log.warn(
            { err, threadId: thread.id },
            'cog-backfill-default-type: could not re-archive after tag apply'
          );
        });
      }
    }
  }

  const defaultName =
    forum.availableTags.find((t) => t.id === defaultTagId)?.name ??
    `tag ${defaultTagId}`;
  const lines = [
    `Default-type backfill for <#${channel.id}> (default: \`${defaultName}\`):`,
    `• ${applied} thread(s) tagged`,
    `• ${alreadyTyped} already had a non-status tag (skipped)`,
    `• ${alreadyHasDefault} already had the default applied (skipped)`,
  ];
  if (atTagCap > 0) {
    lines.push(`• ${atTagCap} skipped — already at Discord's 5-tag cap`);
  }
  if (errors > 0) lines.push(`• ${errors} error(s) — check logs`);
  await interaction.editReply(lines.join('\n'));

  deps.log.info(
    {
      channelId: channel.id,
      cog: `${cog.githubOwner}/${cog.githubRepo}`,
      total: threads.length,
      applied,
      alreadyTyped,
      alreadyHasDefault,
      atTagCap,
      errors,
    },
    'cog-backfill-default-type complete'
  );
}

export async function handleCogTicketControlsRebuild(
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
    await interaction.editReply(
      'This channel isn\'t linked to a cog repository. Run `/cog-link` first.'
    );
    return;
  }

  const forum = (await deps.discord.channels
    .fetch(channel.id)
    .catch(() => null)) as ForumChannel | null;
  if (!forum) {
    await interaction.editReply('Could not fetch the forum channel.');
    return;
  }

  const threads = await fetchAllForumThreads(forum);

  let posted = 0;
  let skipped = 0;
  let errors = 0;

  for (const thread of threads) {
    // Only post to threads we know are linked to GitHub issues — random
    // threads in the forum without a mapping shouldn't get an admin row.
    const [link] = await deps.db
      .select()
      .from(threadIssueMap)
      .where(eq(threadIssueMap.discordThreadId, thread.id))
      .limit(1);
    if (!link) {
      skipped++;
      continue;
    }

    try {
      const has = await threadHasTicketActions(thread);
      if (has) {
        skipped++;
        continue;
      }
      const msg = await postTicketActionsMessage(thread, deps.log);
      if (msg) {
        posted++;
      } else {
        errors++;
      }
    } catch (err) {
      errors++;
      deps.log.warn(
        { err, threadId: thread.id },
        'cog-ticket-controls-rebuild: failed on thread'
      );
    }
  }

  const lines = [
    `Ticket controls rebuild for <#${channel.id}>:`,
    `• ${posted} thread(s) received a fresh control row`,
    `• ${skipped} skipped (already had a row, or not linked)`,
  ];
  if (errors > 0) lines.push(`• ${errors} error(s) — check logs`);
  await interaction.editReply(lines.join('\n'));

  deps.log.info(
    {
      channelId: channel.id,
      cog: `${cog.githubOwner}/${cog.githubRepo}`,
      total: threads.length,
      posted,
      skipped,
      errors,
    },
    'cog-ticket-controls-rebuild complete'
  );
}

async function fetchAllForumThreads(
  forum: ForumChannel
): Promise<ThreadChannel[]> {
  const all: ThreadChannel[] = [];

  const active = await forum.threads.fetchActive();
  all.push(...active.threads.values());

  let before: ThreadChannel | undefined;
  const MAX_PAGES = 20;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await forum.threads.fetchArchived({
      limit: 100,
      ...(before ? { before } : {}),
    });
    const got = [...page.threads.values()];
    if (got.length === 0) break;
    all.push(...got);
    if (!page.hasMore) break;
    before = got[got.length - 1];
  }

  return all;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function handleCogReleaseSet(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const announce = interaction.options.getChannel('announce', false);
  const review = interaction.options.getChannel('review', false);
  const cfSlug = interaction.options.getString('cf_slug', false);
  const wagoSlug = interaction.options.getString('wago_slug', false);

  if (channel.type !== ChannelType.GuildForum) {
    await interaction.reply({
      content: 'Pick a forum channel.',
      ephemeral: true,
    });
    return;
  }

  if (!announce && !review && cfSlug === null && wagoSlug === null) {
    await interaction.reply({
      content:
        'Provide at least one of `announce`, `review`, `cf_slug`, or `wago_slug`.',
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

  const fields: Parameters<typeof setReleaseConfig>[2] = {};
  if (announce) fields.releaseAnnounceChannelId = announce.id;
  if (review) fields.releaseReviewChannelId = review.id;
  if (cfSlug !== null) fields.curseforgeSlug = cfSlug || null;
  if (wagoSlug !== null) fields.wagoSlug = wagoSlug || null;

  await setReleaseConfig(deps.db, channel.id, fields);

  const lines = [`Updated release config on <#${channel.id}>:`];
  if (announce) lines.push(`• announce → <#${announce.id}>`);
  if (review) lines.push(`• review → <#${review.id}>`);
  if (cfSlug !== null) {
    lines.push(`• CurseForge slug → ${cfSlug ? `\`${cfSlug}\`` : '_(cleared)_'}`);
  }
  if (wagoSlug !== null) {
    lines.push(`• Wago slug → ${wagoSlug ? `\`${wagoSlug}\`` : '_(cleared)_'}`);
  }
  await interaction.editReply(lines.join('\n'));
}

export async function handleCogReleaseClear(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const field = interaction.options.getString('field', true);

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

  const fields: Parameters<typeof setReleaseConfig>[2] = {};
  if (field === 'announce' || field === 'all') {
    fields.releaseAnnounceChannelId = null;
  }
  if (field === 'review' || field === 'all') {
    fields.releaseReviewChannelId = null;
  }
  if (field === 'cf_slug' || field === 'all') {
    fields.curseforgeSlug = null;
  }
  if (field === 'wago_slug' || field === 'all') {
    fields.wagoSlug = null;
  }
  await setReleaseConfig(deps.db, channel.id, fields);
  await interaction.editReply(`Cleared ${field} on <#${channel.id}>.`);
}

export async function handleCogReleaseShow(
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

  const lines = [
    `Release config for <#${channel.id}> (**${cog.githubOwner}/${cog.githubRepo}**):`,
    `• announce: ${cog.releaseAnnounceChannelId ? `<#${cog.releaseAnnounceChannelId}>` : '_(unset)_'}`,
    `• review: ${cog.releaseReviewChannelId ? `<#${cog.releaseReviewChannelId}>` : '_(unset)_'}`,
    `• CurseForge slug: ${cog.curseforgeSlug ? `\`${cog.curseforgeSlug}\`` : '_(unset)_'}`,
    `• Wago slug: ${cog.wagoSlug ? `\`${cog.wagoSlug}\`` : '_(unset)_'}`,
  ];
  await interaction.editReply(lines.join('\n'));
}

export async function handleReleaseRedraft(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) {
  const channel = interaction.options.getChannel('channel', true);
  const tag = interaction.options.getString('tag', true);
  const repost = interaction.options.getBoolean('repost', false) ?? false;

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

  const result = await redraftRelease(cog, tag, repost, deps, deps.discord);

  if (result.kind === 'error') {
    await interaction.editReply(result.message);
    return;
  }
  switch (result.kind) {
    case 'drafted':
      await interaction.editReply(
        `Drafted \`${result.row.tag}\` in <#${result.row.reviewChannelId}>.`
      );
      break;
    case 'pending-refreshed':
      await interaction.editReply(
        `Refreshed pending draft for \`${result.row.tag}\`.`
      );
      break;
    case 'announce-edited':
      await interaction.editReply(
        `Edited published announcement for \`${result.row.tag}\` in place.`
      );
      break;
    case 'announce-reposted':
      await interaction.editReply(
        `Reposted announcement for \`${result.row.tag}\` · ${result.fanout.posted} thread followup(s)` +
          (result.fanout.skipped > 0
            ? ` (${result.fanout.skipped} skipped)`
            : '')
      );
      break;
  }
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
