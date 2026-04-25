import type { ThreadChannel } from 'discord.js';
import type { CogChannel } from './channels.js';

export const STATUS_KEYS = [
  'open',
  'closed:completed',
  'closed:not_planned',
  'closed:duplicate',
] as const;

export type StateStatusKey = (typeof STATUS_KEYS)[number];
export type LabelStatusKey = `label:${string}`;
export type StatusKey = StateStatusKey | LabelStatusKey;

export function resolveStatusKey(
  issue: {
    state: string;
    state_reason?: string | null;
    labels?: Array<{ name?: string | null }> | null;
  },
  map: Record<string, string>
): StatusKey {
  // Label-based rules take priority over the built-in state.
  for (const label of issue.labels ?? []) {
    const name = label?.name;
    if (!name) continue;
    const key = `label:${name}` as const;
    if (key in map) return key;
  }
  if (issue.state === 'closed') {
    if (issue.state_reason === 'not_planned') return 'closed:not_planned';
    if (issue.state_reason === 'duplicate') return 'closed:duplicate';
    return 'closed:completed';
  }
  return 'open';
}

// Replace any currently-applied status tag on the thread with the one
// mapped to statusKey (if configured). Non-status tags — the player's
// intake tag, for example — are preserved. Silently no-ops when the key
// is unmapped and there's nothing to clean up.
const DISCORD_MAX_APPLIED_TAGS = 5;

export async function applyStatusTag(
  thread: ThreadChannel,
  cog: CogChannel,
  statusKey: StatusKey
): Promise<void> {
  const targetTagId = cog.statusTagMap[statusKey];
  const statusTagIds = new Set(Object.values(cog.statusTagMap));
  const current = thread.appliedTags;
  const withoutStatus = current.filter((id) => !statusTagIds.has(id));
  const next = targetTagId
    ? [...new Set([...withoutStatus, targetTagId])]
    : withoutStatus;

  const unchanged =
    next.length === current.length && next.every((id) => current.includes(id));
  if (unchanged) return;

  await thread.setAppliedTags(next.slice(0, DISCORD_MAX_APPLIED_TAGS));
}
