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
          { name: 'In progress (branch open)', value: 'in_progress' },
          { name: 'Closed — Completed (verification)', value: 'closed:completed' },
          { name: 'Closed — Not planned (won\'t fix)', value: 'closed:not_planned' },
          { name: 'Closed — Duplicate', value: 'closed:duplicate' },
          { name: 'Released (shipped in published release)', value: 'released' }
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
          { name: 'In progress (branch open)', value: 'in_progress' },
          { name: 'Closed — Completed (verification)', value: 'closed:completed' },
          { name: 'Closed — Not planned (won\'t fix)', value: 'closed:not_planned' },
          { name: 'Closed — Duplicate', value: 'closed:duplicate' },
          { name: 'Released (shipped in published release)', value: 'released' }
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

  new SlashCommandBuilder()
    .setName('cog-default-type-set')
    .setDescription(
      'Set the forum tag applied to imported issues that have no mappable label.'
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
        .setName('tag')
        .setDescription('Forum tag to apply as the default type')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-default-type-unset')
    .setDescription('Clear the default type tag for imported issues.')
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
    .setName('cog-copy-config')
    .setDescription(
      'Copy tag/label/status mappings from one linked forum to another (matched by tag name).'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('from')
        .setDescription('Source forum channel (already linked)')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName('to')
        .setDescription('Destination forum channel (already linked)')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-backfill')
    .setDescription(
      'Back-fill thread→issue mappings from thread names matching [PREFIX-N].'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel to scan')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-backfill-default-type')
    .setDescription(
      'Apply the configured default type tag to any threads that have no intake tag.'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel to scan')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-ticket-controls-rebuild')
    .setDescription(
      'Post the admin Ticket Actions button row to any linked threads that don\'t have one.'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel to scan')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('transcript')
    .setDescription(
      'Post the full Discord transcript for this thread as a comment on the linked issue.'
    )
    .setDMPermission(false)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-import-issues')
    .setDescription(
      'Import existing GitHub issues as Discord threads (clickable picker).'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Linked forum channel to import into')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('state')
        .setDescription('Issue state to list (default: open)')
        .setRequired(false)
        .addChoices(
          { name: 'open (default)', value: 'open' },
          { name: 'closed', value: 'closed' },
          { name: 'all', value: 'all' }
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-release-set')
    .setDescription(
      'Configure release announce/review channels + CF/Wago slugs for a linked cog.'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel of the linked cog')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName('announce')
        .setDescription('Public channel for release announcements')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    )
    .addChannelOption((o) =>
      o
        .setName('review')
        .setDescription('Staff channel for draft review')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .addStringOption((o) =>
      o
        .setName('cf_slug')
        .setDescription('CurseForge addon slug (e.g. "flipqueue"). Empty if not on CF.')
        .setRequired(false)
    )
    .addStringOption((o) =>
      o
        .setName('wago_slug')
        .setDescription('Wago addon slug (e.g. "flipqueue"). Empty if not on Wago.')
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-release-clear')
    .setDescription('Clear release configuration fields on a linked cog.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel of the linked cog')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('field')
        .setDescription('Which field to clear')
        .setRequired(true)
        .addChoices(
          { name: 'announce channel', value: 'announce' },
          { name: 'review channel', value: 'review' },
          { name: 'CurseForge slug', value: 'cf_slug' },
          { name: 'Wago slug', value: 'wago_slug' },
          { name: 'all release fields', value: 'all' }
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-release-show')
    .setDescription('Show release configuration for a linked cog.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel of the linked cog')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('release-redraft')
    .setDescription(
      'Redraft a release announcement (refresh from current issue summaries).'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel of the linked cog')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('tag')
        .setDescription('Release tag (e.g. v0.12.0-alpha1)')
        .setRequired(true)
    )
    .addBooleanOption((o) =>
      o
        .setName('repost')
        .setDescription(
          'Post a fresh announce message instead of editing in place (pings subscribers).'
        )
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('release-check')
    .setDescription(
      'Pre-tag readiness report for a cog: pending issues, player summaries, RELEASES.md, promotion.'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel of the linked cog')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('tag')
        .setDescription('Tag you plan to cut (e.g. v0.14.0) — enables section + promotion checks')
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-roadmap-set')
    .setDescription(
      'Opt a cog into roadmap broadcast and pin its roadmap message.'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel of the linked cog')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName('pin')
        .setDescription('Channel to pin the roadmap message in')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('cog-roadmap-unset')
    .setDescription('Disable roadmap broadcast for a cog and remove its pins.')
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Forum channel of the linked cog')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('scribe-roadmap-aggregate-set')
    .setDescription(
      'Set the suite-wide #roadmap channel for aggregate roadmap pins.'
    )
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel for the aggregate roadmap pins')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('scribe-roadmap-aggregate-clear')
    .setDescription('Clear the suite-wide #roadmap aggregate channel.')
    .setDMPermission(false)
    .toJSON(),
];
