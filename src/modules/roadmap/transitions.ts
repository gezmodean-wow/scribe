// Milestone-transition classification for the per-thread roadmap notifications
// (issue #10). Implements the five rows of the "Discord broadcast — per-issue
// notifications" table in `roadmap-and-version-broadcast.md` (2026-05-07a).
//
// `classifyMilestoneTransition` is pure: it takes the previous milestone title
// (or null) and the next milestone title (or null) and returns a tagged
// result. `renderTransitionMessage` turns that result into the Discord line.
// Splitting the two keeps the table-driven logic unit-testable without a
// GitHub payload or a Discord client.

// `Backlog` is a milestone whose title is exactly "Backlog" (case-insensitive,
// trimmed) per the runbook's milestone-naming rule. Everything else with a
// non-null title is treated as a version milestone — the runbook parses the
// title as a version string but the transition copy only needs to know
// "version vs backlog", so we don't require it to parse as semver here.
function isBacklog(title: string): boolean {
  return title.trim().toLowerCase() === 'backlog';
}

export type MilestoneTransition =
  // Demilestoned entirely, or a no-op change — the runbook says emit nothing
  // and wait for the next milestone event.
  | { kind: 'none' }
  | { kind: 'version-new'; next: string }
  | { kind: 'version-moved'; next: string; prev: string }
  | { kind: 'backlog-new' }
  | { kind: 'backlog-moved'; prev: string };

export function classifyMilestoneTransition(
  prev: string | null,
  next: string | null
): MilestoneTransition {
  // Cleared (demilestoned) — transient; the runbook says no message.
  if (!next) return { kind: 'none' };
  // Milestone object renamed or re-applied to the same milestone: nothing
  // meaningful changed for the player.
  if (prev && prev.trim() === next.trim()) return { kind: 'none' };

  if (isBacklog(next)) {
    return prev ? { kind: 'backlog-moved', prev } : { kind: 'backlog-new' };
  }
  return prev
    ? { kind: 'version-moved', next, prev }
    : { kind: 'version-new', next };
}

// `cogName` is the cog's repo name (e.g. "tally") — the runbook renders it
// lowercase inline with the version, e.g. "**tally v0.14.0**".
export function renderTransitionMessage(
  cogName: string,
  transition: MilestoneTransition
): string | null {
  switch (transition.kind) {
    case 'none':
      return null;
    case 'version-new':
      return `🎯 Targeted for **${cogName} ${transition.next}**.`;
    case 'version-moved':
      return `🎯 Now targeted for **${cogName} ${transition.next}** (was ${transition.prev}).`;
    case 'backlog-new':
      return `📋 Added to the ${cogName} backlog.`;
    case 'backlog-moved':
      return `📋 Moved to the ${cogName} backlog (was ${transition.prev}).`;
  }
}
