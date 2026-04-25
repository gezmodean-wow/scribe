import {
  ChannelType,
  type RESTPostAPIApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from 'discord.js';

export const ticketsCommands: RESTPostAPIApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName('track')
    .setDescription(
      'Track this thread as an issue in the matching cog repository.'
    )
    .setDMPermission(false)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-link')
    .setDescription('Link a forum channel to a cog repository.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel to link')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('owner')
        .setDescription('GitHub owner (org or user)')
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('repo')
        .setDescription('GitHub repository name')
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('prefix')
        .setDescription('Issue ID prefix (e.g. FQ, TMP, MXC)')
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-unlink')
    .setDescription('Remove a forum channel ↔ cog mapping.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel to unlink')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-list')
    .setDescription('Show all forum ↔ cog mappings.')
    .setDMPermission(false)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-tag-set')
    .setDescription('Map a forum tag to a GitHub label for a linked channel.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('tag')
        .setDescription('Forum tag')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('label')
        .setDescription('GitHub label name (must already exist in the repo)')
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-tag-unset')
    .setDescription('Remove a forum tag → GitHub label mapping.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('tag')
        .setDescription('Forum tag')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-tag-list')
    .setDescription('Show tag → label mappings for a forum channel.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-status-set')
    .setDescription(
      'Map a GitHub issue state to a Discord forum tag (SCRIBE-managed).'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('status')
        .setDescription('Issue state')
        .setRequired(true)
        .addChoices(
          { name: 'Open (default / triaged)', value: 'open' },
          { name: 'Closed — Completed', value: 'closed:completed' },
          { name: 'Closed — Not planned', value: 'closed:not_planned' },
          { name: 'Closed — Duplicate', value: 'closed:duplicate' }
        )
    )
    .addStringOption((o) =>
      o
        .setName('tag')
        .setDescription('Forum tag to apply for this status')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-status-unset')
    .setDescription('Remove a GitHub state → forum tag mapping.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('status')
        .setDescription('Issue state')
        .setRequired(true)
        .addChoices(
          { name: 'Open (default / triaged)', value: 'open' },
          { name: 'Closed — Completed', value: 'closed:completed' },
          { name: 'Closed — Not planned', value: 'closed:not_planned' },
          { name: 'Closed — Duplicate', value: 'closed:duplicate' }
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-status-list')
    .setDescription('Show state + label → tag mappings for a forum channel.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-label-set')
    .setDescription(
      'Map a GitHub label to a Discord forum tag (SCRIBE-managed, overrides state).'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('label')
        .setDescription('GitHub label name (e.g. status:in-progress)')
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('tag')
        .setDescription('Forum tag to apply when this label is on the issue')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-label-unset')
    .setDescription('Remove a GitHub label → forum tag mapping.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('label')
        .setDescription('GitHub label name')
        .setRequired(true)
    )
    .toJSON(),
];
