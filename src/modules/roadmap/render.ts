import { EmbedBuilder } from 'discord.js';
import { parseReleaseTag } from '../tickets/release-notes.js';

// Pure render layer for the pinned roadmap messages (issue #10). Mirrors the
// "Discord broadcast — pinned roadmap messages" format in
// `roadmap-and-version-broadcast.md` (2026-05-07a). Everything here is
// in/out with no Discord or GitHub I/O, so it's snapshot-testable.

// Roadmap pin embed colour — Discord blurple. Roadmap pins aren't tied to a
// release channel, so they don't reuse the alpha/beta/release palette.
const ROADMAP_COLOR = 0x5865f2;

// One inline title costs a bullet line; the runbook caps the inline list at
// three and counts the rest with `_(+N more)_`.
const INLINE_TITLE_CAP = 3;

export type RoadmapMilestone = {
  title: string;
  htmlUrl: string;
  // Issue counts from the GitHub milestone object. `openCount` drives the
  // "N issues" / "+N more" figures; both together give "X of Y done".
  openCount: number;
  closedCount: number;
  kind: 'version' | 'backlog' | 'other';
  // Up to INLINE_TITLE_CAP open-issue titles, for version milestones only.
  openIssueTitles: string[];
};

export type CogRoadmap = {
  milestones: RoadmapMilestone[];
};

// Classifies a milestone title into the three buckets the renderer cares
// about. `Backlog` is matched case-insensitively; anything that parses as a
// version tag is a version milestone; everything else ("other") still renders
// but collapsed, so an off-convention milestone title is visible rather than
// silently dropped.
export function classifyMilestoneKind(
  title: string
): RoadmapMilestone['kind'] {
  if (title.trim().toLowerCase() === 'backlog') return 'backlog';
  return parseReleaseTag(title) ? 'version' : 'other';
}

// Sort order for display: version milestones ascending by semver, then
// "other", then Backlog last (it's the permanent parking spot, so it sits at
// the bottom of the pin).
export function sortMilestones(
  milestones: RoadmapMilestone[]
): RoadmapMilestone[] {
  const rank = { version: 0, other: 1, backlog: 2 };
  return [...milestones].sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    if (a.kind === 'version') {
      const pa = parseReleaseTag(a.title);
      const pb = parseReleaseTag(b.title);
      if (pa && pb) {
        if (pa.major !== pb.major) return pa.major - pb.major;
        if (pa.minor !== pb.minor) return pa.minor - pb.minor;
        if (pa.patch !== pb.patch) return pa.patch - pb.patch;
      }
    }
    return a.title.localeCompare(b.title);
  });
}

// The "in development" milestone is the lowest-versioned open version
// milestone. Returns its title, or null when the cog has no version
// milestone open (Backlog-only, or nothing triaged yet).
export function activeMilestoneTitle(roadmap: CogRoadmap): string | null {
  const sorted = sortMilestones(roadmap.milestones);
  return sorted.find((m) => m.kind === 'version')?.title ?? null;
}

// "Tally" from "tally" — the runbook capitalises the cog name in the pin
// title ("📍 Tally roadmap") while keeping it lowercase in inline prose.
function displayCogName(repo: string): string {
  return repo.charAt(0).toUpperCase() + repo.slice(1);
}

// "2026-05-07 14:33 UTC" — the runbook's last-updated stamp format.
export function formatUpdatedAt(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// Renders one milestone as a markdown block. `expanded` controls whether the
// inline issue-title list is shown: the per-cog pin expands every version
// milestone; the aggregate pin expands only the in-development one.
function renderMilestoneBlock(
  m: RoadmapMilestone,
  opts: { active: boolean; expanded: boolean }
): string {
  const link = `[GitHub →](${m.htmlUrl})`;

  if (m.kind === 'version' && opts.expanded) {
    const total = m.openCount + m.closedCount;
    const statusWord = opts.active ? 'in development' : 'planned';
    const lines = [
      `**${m.title}** — ${statusWord} · ${m.closedCount} of ${total} done · ${link}`,
    ];
    for (const title of m.openIssueTitles.slice(0, INLINE_TITLE_CAP)) {
      lines.push(`  • ${title}`);
    }
    const more = m.openCount - Math.min(m.openIssueTitles.length, INLINE_TITLE_CAP);
    if (more > 0) lines.push(`  _(+${more} more)_`);
    return lines.join('\n');
  }

  // Collapsed: Backlog, "other", or a non-active version milestone in the
  // aggregate pin. Name + open count + link, one line.
  return `**${m.title}** — ${m.openCount} issues · ${link}`;
}

const FOOTER_NOTE =
  "Each report's status is also posted in its own thread when its milestone changes.";

// Per-cog channel pin: every open milestone, version milestones expanded.
export function renderCogPin(
  repo: string,
  roadmap: CogRoadmap,
  now: Date
): EmbedBuilder {
  const sorted = sortMilestones(roadmap.milestones);
  const active = activeMilestoneTitle(roadmap);

  const blocks =
    sorted.length === 0
      ? ['_No open milestones._']
      : sorted.map((m) =>
          renderMilestoneBlock(m, {
            active: m.title === active,
            expanded: true,
          })
        );

  return new EmbedBuilder()
    .setColor(ROADMAP_COLOR)
    .setTitle(`📍 ${displayCogName(repo)} roadmap`)
    .setDescription(`${blocks.join('\n\n')}\n\n_${FOOTER_NOTE}_`)
    .setFooter({ text: `last updated ${formatUpdatedAt(now)}` });
}

// Aggregate `#roadmap` pin row: one embed per cog, only the in-development
// milestone expanded so each stays well under Discord's embed cap.
export function renderAggregateRow(
  repo: string,
  roadmap: CogRoadmap,
  now: Date
): EmbedBuilder {
  const sorted = sortMilestones(roadmap.milestones);
  const active = activeMilestoneTitle(roadmap);

  const blocks =
    sorted.length === 0
      ? ['_No open milestones._']
      : sorted.map((m) =>
          renderMilestoneBlock(m, {
            active: m.title === active,
            expanded: m.title === active,
          })
        );

  return new EmbedBuilder()
    .setColor(ROADMAP_COLOR)
    .setTitle(`📍 ${displayCogName(repo)}`)
    .setDescription(blocks.join('\n\n'))
    .setFooter({ text: `last updated ${formatUpdatedAt(now)}` });
}
