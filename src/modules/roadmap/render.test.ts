import { describe, expect, it } from 'vitest';
import {
  activeMilestoneTitle,
  classifyMilestoneKind,
  formatUpdatedAt,
  renderAggregateRow,
  renderCogPin,
  sortMilestones,
  type RoadmapMilestone,
} from './render.js';

// A fixed timestamp keeps the "last updated" footer deterministic for
// snapshots.
const NOW = new Date('2026-05-07T14:33:12.000Z');

function version(
  title: string,
  over: Partial<RoadmapMilestone> = {}
): RoadmapMilestone {
  return {
    title,
    htmlUrl: `https://github.com/gezmodean-wow/tally/milestone/${title}`,
    openCount: 5,
    closedCount: 7,
    kind: 'version',
    openIssueTitles: [
      'Bag stuck after auction posted',
      'Net-worth panel flicker on rest tick',
      'Per-item research column wraps at narrow widths',
    ],
    ...over,
  };
}

const BACKLOG: RoadmapMilestone = {
  title: 'Backlog',
  htmlUrl: 'https://github.com/gezmodean-wow/tally/milestone/1',
  openCount: 23,
  closedCount: 0,
  kind: 'backlog',
  openIssueTitles: [],
};

describe('classifyMilestoneKind', () => {
  it('treats a version tag as a version milestone', () => {
    expect(classifyMilestoneKind('v0.14.0')).toBe('version');
  });
  it('treats Backlog as the backlog, case-insensitively', () => {
    expect(classifyMilestoneKind('backlog')).toBe('backlog');
  });
  it('treats an off-convention title as "other"', () => {
    expect(classifyMilestoneKind('Someday maybe')).toBe('other');
  });
});

describe('sortMilestones', () => {
  it('orders versions ascending, then other, then Backlog last', () => {
    const sorted = sortMilestones([
      BACKLOG,
      version('v0.14.0'),
      { ...version('Cleanup'), kind: 'other', title: 'Cleanup' },
      version('v0.13.5'),
    ]);
    expect(sorted.map((m) => m.title)).toEqual([
      'v0.13.5',
      'v0.14.0',
      'Cleanup',
      'Backlog',
    ]);
  });
});

describe('activeMilestoneTitle', () => {
  it('is the lowest open version milestone', () => {
    expect(
      activeMilestoneTitle({
        milestones: [BACKLOG, version('v0.14.0'), version('v0.13.5')],
      })
    ).toBe('v0.13.5');
  });
  it('is null when no version milestone is open', () => {
    expect(activeMilestoneTitle({ milestones: [BACKLOG] })).toBeNull();
  });
});

describe('formatUpdatedAt', () => {
  it('formats as "YYYY-MM-DD HH:MM UTC"', () => {
    expect(formatUpdatedAt(NOW)).toBe('2026-05-07 14:33 UTC');
  });
});

describe('renderCogPin', () => {
  const embed = renderCogPin(
    'tally',
    { milestones: [version('v0.14.0'), BACKLOG] },
    NOW
  ).toJSON();

  it('titles the embed with the capitalised cog name', () => {
    expect(embed.title).toBe('📍 Tally roadmap');
  });

  it('expands the version milestone with progress and inline titles', () => {
    expect(embed.description).toContain(
      '**v0.14.0** — in development · 7 of 12 done'
    );
    expect(embed.description).toContain('• Bag stuck after auction posted');
    // openCount 5, three shown inline → "+2 more".
    expect(embed.description).toContain('_(+2 more)_');
  });

  it('collapses Backlog to a count line', () => {
    expect(embed.description).toContain('**Backlog** — 23 issues');
  });

  it('stamps the footer with the update time', () => {
    expect(embed.footer?.text).toBe('last updated 2026-05-07 14:33 UTC');
  });

  it('matches the rendered snapshot', () => {
    expect(embed).toMatchSnapshot();
  });
});

describe('renderAggregateRow', () => {
  const embed = renderAggregateRow(
    'tally',
    { milestones: [version('v0.13.5'), version('v0.14.0'), BACKLOG] },
    NOW
  ).toJSON();

  it('expands only the in-development milestone', () => {
    // v0.13.5 is active → expanded with bullets.
    expect(embed.description).toContain(
      '**v0.13.5** — in development · 7 of 12 done'
    );
    expect(embed.description).toContain('• Bag stuck after auction posted');
  });

  it('collapses non-active version milestones to a count line', () => {
    expect(embed.description).toContain('**v0.14.0** — 5 issues');
  });

  it('matches the rendered snapshot', () => {
    expect(embed).toMatchSnapshot();
  });
});
