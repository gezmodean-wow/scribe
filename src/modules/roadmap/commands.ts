import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import { findCogForChannel, updateRoadmapFields } from '../tickets/channels.js';
import type { TicketsModuleDeps } from '../tickets/index.js';
import {
  clearAggregatePins,
  deleteCogRoadmapPins,
  renderAllRoadmaps,
  renderCogRoadmap,
} from './pins.js';
import { getAppSettings, setRoadmapAggregateChannel } from './settings.js';

// Slash-command handlers for the roadmap module (issue #10). Builders live in
// `tickets/commands.ts` alongside the rest of the command registration; these
// stay in the roadmap module so the feature is self-contained. All four are
// staff-gated by the shared authorization check in `interactions.ts`.

// Channel types that can hold a pinned roadmap message. Forum channels can't —
// they contain threads, not loose messages — so the pin target is a regular
// text (or announcement) channel, distinct from the cog's feedback forum.
const PIN_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
];

// `/cog-roadmap-set channel:<forum> pin:<text-channel>` — opts a cog into
// roadmap broadcast and renders its first pin. `channel` identifies the linked
// cog (consistent with every other `cog-*` command); `pin` is where the
// pinned message goes.
export async function handleCogRoadmapSet(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const pin = interaction.options.getChannel('pin', true);

  if (channel.type !== ChannelType.GuildForum) {
    await interaction.reply({
      content: 'Pick a forum channel for `channel`.',
      ephemeral: true,
    });
    return;
  }
  if (!PIN_CHANNEL_TYPES.includes(pin.type as (typeof PIN_CHANNEL_TYPES)[number])) {
    await interaction.reply({
      content: 'Pick a text or announcement channel for `pin`.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const cog = await findCogForChannel(deps.db, channel.id);
  if (!cog) {
    await interaction.editReply(
      "This channel isn't linked to a cog repository. Run `/cog-link` first."
    );
    return;
  }

  const updated = await updateRoadmapFields(deps.db, channel.id, {
    roadmapPinChannelId: pin.id,
  });
  if (updated) await renderCogRoadmap(updated, deps);

  await interaction.editReply(
    `Roadmap pin for **${cog.githubOwner}/${cog.githubRepo}** → <#${pin.id}>. Initial pin posted.`
  );
}

// `/cog-roadmap-unset channel:<forum>` — opts a cog back out: deletes its pins
// and clears the stored ids. The rollout gate (`roadmapPinChannelId`) going
// NULL is what stops future renders.
export async function handleCogRoadmapUnset(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
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
    await interaction.editReply("This channel isn't linked.");
    return;
  }
  if (!cog.roadmapPinChannelId) {
    await interaction.editReply('Roadmap broadcast is not configured here.');
    return;
  }

  await deleteCogRoadmapPins(cog, deps);
  await updateRoadmapFields(deps.db, channel.id, {
    roadmapPinChannelId: null,
    roadmapPinMessageId: null,
    roadmapAggregatePinMessageId: null,
  });

  await interaction.editReply(
    `Roadmap broadcast disabled for **${cog.githubOwner}/${cog.githubRepo}**.`
  );
}

// `/scribe-roadmap-aggregate-set channel:<text-channel>` — sets the suite-wide
// `#roadmap` channel and renders every opted-in cog's row into it.
export async function handleScribeRoadmapAggregateSet(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);

  if (!PIN_CHANNEL_TYPES.includes(channel.type as (typeof PIN_CHANNEL_TYPES)[number])) {
    await interaction.reply({
      content: 'Pick a text or announcement channel.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  await setRoadmapAggregateChannel(deps.db, channel.id);
  await renderAllRoadmaps(deps);

  await interaction.editReply(
    `Aggregate roadmap channel → <#${channel.id}>. Per-cog rows posted.`
  );
}

// `/scribe-roadmap-aggregate-clear` — removes the aggregate channel, deleting
// each cog's aggregate row first so nothing is orphaned.
export async function handleScribeRoadmapAggregateClear(
  interaction: ChatInputCommandInteraction,
  deps: TicketsModuleDeps
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const settings = await getAppSettings(deps.db);
  if (!settings?.roadmapAggregateChannelId) {
    await interaction.editReply('No aggregate roadmap channel is set.');
    return;
  }

  const deleted = await clearAggregatePins(deps);
  await setRoadmapAggregateChannel(deps.db, null);

  await interaction.editReply(
    `Aggregate roadmap channel cleared (${deleted} row(s) removed).`
  );
}
