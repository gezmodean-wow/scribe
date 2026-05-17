import type { EmbedBuilder, TextChannel } from 'discord.js';
import {
  listRoadmapCogs,
  updateRoadmapFields,
  type CogChannel,
} from '../tickets/channels.js';
import type { TicketsModuleDeps } from '../tickets/index.js';
import { fetchTextChannel } from '../tickets/releases.js';
import { fetchCogRoadmap } from './github.js';
import { renderAggregateRow, renderCogPin, type CogRoadmap } from './render.js';
import { getAppSettings } from './settings.js';

// Pin lifecycle for the roadmap module (issue #10): fetch milestone state,
// render the embeds, and edit them in place — self-healing to a fresh
// create-and-pin when the stored message id is gone (hand-deleted, or a first
// render). Mirrors the create/edit fallback `releases.ts` uses for review and
// announce messages.

// Edits the pinned embed in place, or creates and pins a fresh one when the
// stored id is missing or unreachable. Returns the (possibly new) message id,
// or null when the channel rejected both paths (e.g. lost permissions) — the
// caller logs and leaves the stored id untouched so a later tick can recover.
async function upsertPinnedEmbed(
  channel: TextChannel,
  messageId: string | null,
  embed: EmbedBuilder,
  deps: TicketsModuleDeps
): Promise<string | null> {
  if (messageId) {
    const existing = await channel.messages
      .fetch(messageId)
      .catch(() => null);
    if (existing) {
      try {
        await existing.edit({ embeds: [embed] });
        return existing.id;
      } catch (err) {
        deps.log.error(
          { err, channelId: channel.id, messageId },
          'roadmap: could not edit pinned message'
        );
        return null;
      }
    }
  }

  // Self-heal: stored id missing or 404'd — post a new message and pin it.
  try {
    const msg = await channel.send({ embeds: [embed] });
    await msg.pin().catch((err) => {
      deps.log.warn(
        { err, channelId: channel.id, messageId: msg.id },
        'roadmap: posted roadmap message but could not pin it'
      );
    });
    return msg.id;
  } catch (err) {
    deps.log.error(
      { err, channelId: channel.id },
      'roadmap: could not post roadmap message'
    );
    return null;
  }
}

// Renders (or refreshes) one cog's roadmap pins: the per-cog channel pin and,
// when an aggregate channel is configured, that cog's row in `#roadmap`.
// No-ops when the cog hasn't opted in (`roadmapPinChannelId` is the gate).
export async function renderCogRoadmap(
  cog: CogChannel,
  deps: TicketsModuleDeps
): Promise<void> {
  if (!cog.roadmapPinChannelId) return;

  let roadmap: CogRoadmap;
  try {
    roadmap = await fetchCogRoadmap(cog.githubOwner, cog.githubRepo, deps);
  } catch (err) {
    deps.log.warn(
      { err, cog: `${cog.githubOwner}/${cog.githubRepo}` },
      'roadmap: GitHub fetch failed; skipping render this tick'
    );
    return;
  }
  const now = new Date();

  const pinChannel = await fetchTextChannel(
    deps.discord,
    cog.roadmapPinChannelId,
    deps
  );
  if (pinChannel) {
    const embed = renderCogPin(cog.githubRepo, roadmap, now);
    const newId = await upsertPinnedEmbed(
      pinChannel,
      cog.roadmapPinMessageId,
      embed,
      deps
    );
    if (newId && newId !== cog.roadmapPinMessageId) {
      await updateRoadmapFields(deps.db, cog.discordChannelId, {
        roadmapPinMessageId: newId,
      });
    }
  }

  const settings = await getAppSettings(deps.db);
  if (settings?.roadmapAggregateChannelId) {
    const aggChannel = await fetchTextChannel(
      deps.discord,
      settings.roadmapAggregateChannelId,
      deps
    );
    if (aggChannel) {
      const embed = renderAggregateRow(cog.githubRepo, roadmap, now);
      const newId = await upsertPinnedEmbed(
        aggChannel,
        cog.roadmapAggregatePinMessageId,
        embed,
        deps
      );
      if (newId && newId !== cog.roadmapAggregatePinMessageId) {
        await updateRoadmapFields(deps.db, cog.discordChannelId, {
          roadmapAggregatePinMessageId: newId,
        });
      }
    }
  }
}

// Re-renders every opted-in cog, sequentially. Used by the refresh timer and
// by `/scribe-roadmap-aggregate-set`. Volume is ~one edit per cog, so the
// sequential walk keeps things simple and rate-limit-friendly.
export async function renderAllRoadmaps(deps: TicketsModuleDeps): Promise<void> {
  const cogs = await listRoadmapCogs(deps.db);
  for (const cog of cogs) {
    await renderCogRoadmap(cog, deps).catch((err) => {
      deps.log.error(
        { err, cog: `${cog.githubOwner}/${cog.githubRepo}` },
        'roadmap: render failed for cog'
      );
    });
  }
}

// Best-effort deletion of a message id in a channel — used when tearing down
// roadmap config so stale pins don't linger.
async function deleteMessageIfPresent(
  deps: TicketsModuleDeps,
  channelId: string,
  messageId: string | null
): Promise<void> {
  if (!messageId) return;
  const channel = await fetchTextChannel(deps.discord, channelId, deps);
  if (!channel) return;
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  await msg?.delete().catch((err) => {
    deps.log.warn(
      { err, channelId, messageId },
      'roadmap: could not delete roadmap message during teardown'
    );
  });
}

// Deletes every cog's aggregate-channel row and clears the stored id. Used by
// `/scribe-roadmap-aggregate-clear`. Returns how many rows were cleared.
export async function clearAggregatePins(
  deps: TicketsModuleDeps
): Promise<number> {
  const settings = await getAppSettings(deps.db);
  const channelId = settings?.roadmapAggregateChannelId;
  const cogs = await listRoadmapCogs(deps.db);

  let cleared = 0;
  for (const cog of cogs) {
    if (!cog.roadmapAggregatePinMessageId) continue;
    if (channelId) {
      await deleteMessageIfPresent(
        deps,
        channelId,
        cog.roadmapAggregatePinMessageId
      );
    }
    await updateRoadmapFields(deps.db, cog.discordChannelId, {
      roadmapAggregatePinMessageId: null,
    });
    cleared++;
  }
  return cleared;
}

// Removes a cog's roadmap pins: the per-cog channel pin and its aggregate row
// (if any). Caller is responsible for clearing the stored ids afterward.
export async function deleteCogRoadmapPins(
  cog: CogChannel,
  deps: TicketsModuleDeps
): Promise<void> {
  if (cog.roadmapPinChannelId) {
    await deleteMessageIfPresent(
      deps,
      cog.roadmapPinChannelId,
      cog.roadmapPinMessageId
    );
  }
  const settings = await getAppSettings(deps.db);
  if (settings?.roadmapAggregateChannelId) {
    await deleteMessageIfPresent(
      deps,
      settings.roadmapAggregateChannelId,
      cog.roadmapAggregatePinMessageId
    );
  }
}
