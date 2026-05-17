import type {
  APIInteractionGuildMember,
  ChatInputCommandInteraction,
  GuildMember,
} from 'discord.js';
import {
  EDIT_MODAL_PREFIX,
  handleReleaseButton,
  handleReleaseModalSubmit,
  isReleaseButtonId,
} from './releases.js';
import {
  handleCogBackfill,
  handleCogBackfillDefaultType,
  handleCogCopyConfig,
  handleCogDefaultTypeSet,
  handleCogDefaultTypeUnset,
  handleCogLabelSet,
  handleCogLabelUnset,
  handleCogLink,
  handleCogList,
  handleCogReleaseClear,
  handleCogReleaseSet,
  handleCogReleaseShow,
  handleCogStatusList,
  handleCogStatusSet,
  handleCogStatusUnset,
  handleCogTagList,
  handleCogTagSet,
  handleCogTagUnset,
  handleCogTicketControlsRebuild,
  handleCogUnlink,
  handleReleaseRedraft,
  handleTagAutocomplete,
  handleTrack,
} from './handlers.js';
import {
  handleCogImportIssues,
  handleImportButton,
  handleImportSelect,
  isImportComponentId,
} from './import.js';
import {
  handleTicketActionButton,
  isTicketActionId,
} from './ticket-actions.js';
import { handleTranscriptCommand } from './transcript.js';
import {
  handleCogRoadmapSet,
  handleCogRoadmapUnset,
  handleScribeRoadmapAggregateClear,
  handleScribeRoadmapAggregateSet,
} from '../roadmap/index.js';
import type { TicketsModuleDeps } from './index.js';

type Handler = (
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  track: handleTrack,
  'cog-link': handleCogLink,
  'cog-unlink': handleCogUnlink,
  'cog-list': handleCogList,
  'cog-tag-set': handleCogTagSet,
  'cog-tag-unset': handleCogTagUnset,
  'cog-tag-list': handleCogTagList,
  'cog-status-set': handleCogStatusSet,
  'cog-status-unset': handleCogStatusUnset,
  'cog-status-list': handleCogStatusList,
  'cog-label-set': handleCogLabelSet,
  'cog-label-unset': handleCogLabelUnset,
  'cog-backfill': handleCogBackfill,
  'cog-backfill-default-type': handleCogBackfillDefaultType,
  'cog-ticket-controls-rebuild': handleCogTicketControlsRebuild,
  'cog-import-issues': handleCogImportIssues,
  'cog-default-type-set': handleCogDefaultTypeSet,
  'cog-default-type-unset': handleCogDefaultTypeUnset,
  'cog-copy-config': handleCogCopyConfig,
  'cog-release-set': handleCogReleaseSet,
  'cog-release-clear': handleCogReleaseClear,
  'cog-release-show': handleCogReleaseShow,
  'release-redraft': handleReleaseRedraft,
  'cog-roadmap-set': handleCogRoadmapSet,
  'cog-roadmap-unset': handleCogRoadmapUnset,
  'scribe-roadmap-aggregate-set': handleScribeRoadmapAggregateSet,
  'scribe-roadmap-aggregate-clear': handleScribeRoadmapAggregateClear,
  transcript: handleTranscriptCommand,
};

const AUTOCOMPLETE_COMMANDS = new Set([
  'cog-tag-set',
  'cog-tag-unset',
  'cog-status-set',
  'cog-label-set',
  'cog-default-type-set',
]);

export function registerTicketsInteractions(deps: TicketsModuleDeps) {
  deps.discord.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
      if (AUTOCOMPLETE_COMMANDS.has(interaction.commandName)) {
        await handleTagAutocomplete(interaction, deps).catch((err) =>
          deps.log.warn({ err }, 'autocomplete failed')
        );
      }
      return;
    }

    if (interaction.isButton() && isTicketActionId(interaction.customId)) {
      if (
        !isAuthorized(interaction.member, deps.config.discord.staffRoleIds)
      ) {
        await interaction.reply({
          content: "You don't have permission to use this control.",
          ephemeral: true,
        });
        return;
      }
      try {
        await handleTicketActionButton(interaction, deps);
      } catch (err) {
        deps.log.error(
          { err, customId: interaction.customId },
          'ticket-action button handler failed'
        );
        const msg = 'Something went wrong. Check the logs.';
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction
            .reply({ content: msg, ephemeral: true })
            .catch(() => {});
        }
      }
      return;
    }

    if (interaction.isButton() && isReleaseButtonId(interaction.customId)) {
      if (
        !isAuthorized(interaction.member, deps.config.discord.staffRoleIds)
      ) {
        await interaction.reply({
          content: "You don't have permission to use this control.",
          ephemeral: true,
        });
        return;
      }
      try {
        await handleReleaseButton(interaction, deps);
      } catch (err) {
        deps.log.error(
          { err, customId: interaction.customId },
          'release button handler failed'
        );
        const msg = 'Something went wrong. Check the logs.';
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction
            .reply({ content: msg, ephemeral: true })
            .catch(() => {});
        }
      }
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      isImportComponentId(interaction.customId)
    ) {
      if (
        !isAuthorized(interaction.member, deps.config.discord.staffRoleIds)
      ) {
        await interaction.reply({
          content: "You don't have permission to use this control.",
          ephemeral: true,
        });
        return;
      }
      try {
        await handleImportSelect(interaction);
      } catch (err) {
        deps.log.error(
          { err, customId: interaction.customId },
          'import select handler failed'
        );
      }
      return;
    }

    if (interaction.isButton() && isImportComponentId(interaction.customId)) {
      if (
        !isAuthorized(interaction.member, deps.config.discord.staffRoleIds)
      ) {
        await interaction.reply({
          content: "You don't have permission to use this control.",
          ephemeral: true,
        });
        return;
      }
      try {
        await handleImportButton(interaction, deps);
      } catch (err) {
        deps.log.error(
          { err, customId: interaction.customId },
          'import button handler failed'
        );
        const msg = 'Something went wrong. Check the logs.';
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction
            .reply({ content: msg, ephemeral: true })
            .catch(() => {});
        }
      }
      return;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith(EDIT_MODAL_PREFIX)
    ) {
      if (
        !isAuthorized(interaction.member, deps.config.discord.staffRoleIds)
      ) {
        await interaction.reply({
          content: "You don't have permission to edit this draft.",
          ephemeral: true,
        });
        return;
      }
      try {
        await handleReleaseModalSubmit(interaction, deps);
      } catch (err) {
        deps.log.error(
          { err, customId: interaction.customId },
          'release modal handler failed'
        );
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const handler = HANDLERS[interaction.commandName];
    if (!handler) return;

    if (!isAuthorized(interaction.member, deps.config.discord.staffRoleIds)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    try {
      await handler(interaction, deps);
    } catch (err) {
      deps.log.error(
        { err, command: interaction.commandName },
        'slash command handler failed'
      );
      const msg = 'Something went wrong. Check the logs.';
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction
          .reply({ content: msg, ephemeral: true })
          .catch(() => {});
      }
    }
  });
}

function isAuthorized(
  member: GuildMember | APIInteractionGuildMember | null,
  allowedRoleIds: string[]
): boolean {
  if (!member) return false;

  const memberRoleIds =
    'cache' in member.roles
      ? Array.from(member.roles.cache.keys())
      : member.roles;

  return allowedRoleIds.some((id) => memberRoleIds.includes(id));
}
