import { describe, expect, it } from 'vitest';
import {
  classifyIssueFraming,
  composeDraft,
  type ShippedIssue,
} from './releases.js';
import { classifyReleasesSectionMatch } from './release-notes.js';

function issue(over: Partial<ShippedIssue> & { number: number }): ShippedIssue {
  return {
    title: `issue ${over.number}`,
    htmlUrl: `https://github.com/o/r/issues/${over.number}`,
    state: 'closed',
    summary: null,
    hadPlayerUpdate: false,
    ...over,
  };
}

describe('composeDraft — promotion render', () => {
  const base = {
    repoName: 'flipqueue',
    tag: 'v0.14.0',
    title: 'v0.14.0',
    releaseUrl: 'https://github.com/o/r/releases/v0.14.0',
    downloadLinks: ['[CurseForge](cf)'],
    channelKind: 'release' as const,
    releasesSection: 'Some RELEASES.md prose.',
    renderMode: 'full' as const,
    priorTag: null,
  };

  it('leads with the promotion framing instead of re-announcing the work', () => {
    const body = composeDraft({
      ...base,
      issues: [],
      promotion: {
        fromTags: ['v0.14.0-alpha2'],
        cohortTags: ['v0.14.0-alpha1', 'v0.14.0-alpha2'],
        promotedIssues: [
          issue({ number: 249, summary: 'Gold withdrawal no longer double-counts' }),
        ],
      },
    });

    expect(body).toContain('**flipqueue v0.14.0** · Promoted to stable');
    expect(body).toContain('## Promoting v0.14.0 to stable');
    expect(body).toContain('Same build as `v0.14.0-alpha2`');
    expect(body).toContain('**Promoted from alpha/beta** (1 issue)');
    expect(body).toContain(
      '- Gold withdrawal no longer double-counts · [#249](https://github.com/o/r/issues/249)'
    );
    // A promotion is not new prose — the RELEASES.md section belongs to the
    // release that first shipped this code.
    expect(body).not.toContain('Some RELEASES.md prose.');
  });

  it('splits promoted and newly-fixed cohorts', () => {
    const body = composeDraft({
      ...base,
      issues: [issue({ number: 260, summary: 'Late fix' })],
      promotion: {
        fromTags: ['v0.14.0-alpha2'],
        cohortTags: ['v0.14.0-alpha2'],
        promotedIssues: [issue({ number: 249, summary: 'Earlier fix' })],
      },
    });

    expect(body).toContain('**Promoted from alpha/beta** (1 issue)');
    expect(body).toContain('**Newly fixed in this release** (1 issue)');
    expect(body.indexOf('#249')).toBeLessThan(body.indexOf('#260'));
  });

  it('still flags issues that shipped without a player summary', () => {
    const body = composeDraft({
      ...base,
      issues: [],
      promotion: {
        fromTags: ['v0.14.0-alpha1'],
        cohortTags: ['v0.14.0-alpha1'],
        promotedIssues: [issue({ number: 249, hadPlayerUpdate: true })],
      },
    });

    expect(body).toContain('## ⚠️ No player summary written');
    expect(body).toContain('had Player updates but no Player summary in body');
  });

  it('leaves the non-promotion path untouched', () => {
    const body = composeDraft({
      ...base,
      issues: [issue({ number: 1, summary: 'A fix' })],
      promotion: null,
    });

    expect(body).toContain('**flipqueue v0.14.0** · Release');
    expect(body).toContain('Some RELEASES.md prose.');
    expect(body).toContain('_Issues shipped: #1_');
    expect(body).not.toContain('Promoting');
  });
});

describe('classifyIssueFraming', () => {
  const promotionRow = {
    tag: 'v0.14.0',
    channel: 'release',
    promotedFromTags: ['v0.14.0-alpha1'],
  };
  const plainStable = { tag: 'v0.14.0', channel: 'release', promotedFromTags: [] };
  const alphaRow = {
    tag: 'v0.14.0-alpha1',
    channel: 'alpha',
    promotedFromTags: [],
  };
  const unshipped = {
    firstReleasedTag: null,
    firstReleasedChannel: null,
    promotedToStableTag: null,
  };
  const shippedInAlpha = {
    firstReleasedTag: 'v0.14.0-alpha1',
    firstReleasedChannel: 'alpha',
    promotedToStableTag: null,
  };

  it('is newly-fixed the first time an issue ships, in any channel', () => {
    expect(classifyIssueFraming(alphaRow, unshipped)).toBe('newly-fixed');
    expect(classifyIssueFraming(plainStable, unshipped)).toBe('newly-fixed');
  });

  it('is promoted when a stable re-tag picks up an alpha-shipped issue', () => {
    expect(classifyIssueFraming(promotionRow, shippedInAlpha)).toBe('promoted');
  });

  it('is not promoted when the stable tag is new code rather than a re-tag', () => {
    expect(classifyIssueFraming(plainStable, shippedInAlpha)).toBe('re-announced');
  });

  it('is not promoted twice', () => {
    expect(
      classifyIssueFraming(promotionRow, {
        ...shippedInAlpha,
        promotedToStableTag: 'v0.14.0',
      })
    ).toBe('promoted');
  });

  it('does not promote an issue that first shipped on an earlier version line', () => {
    expect(
      classifyIssueFraming(promotionRow, {
        firstReleasedTag: 'v0.13.0-alpha1',
        firstReleasedChannel: 'alpha',
        promotedToStableTag: null,
      })
    ).toBe('re-announced');
  });

  it('treats rows predating channel-state tracking as newly-fixed', () => {
    // Backfill decision on issue #3: leave existing rows NULL, forward-only.
    expect(classifyIssueFraming(promotionRow, unshipped)).toBe('newly-fixed');
  });
});

describe('classifyReleasesSectionMatch', () => {
  const body = [
    '# Releases',
    '',
    '## v0.14.0',
    '',
    'Prose for the 0.14 line.',
    '',
    '## Unreleased',
    '',
    'Nothing yet.',
  ].join('\n');

  it('reports an exact section hit', () => {
    expect(classifyReleasesSectionMatch(body, 'v0.14.0')).toBe('exact');
  });

  it('reports the base-version fallback for an alpha', () => {
    expect(classifyReleasesSectionMatch(body, 'v0.14.0-alpha2')).toBe('base');
  });

  it('reports the Unreleased fallback', () => {
    expect(classifyReleasesSectionMatch(body, 'v0.15.0')).toBe('unreleased');
  });

  it('reports none when the file has nothing usable', () => {
    expect(classifyReleasesSectionMatch('# Releases\n', 'v0.15.0')).toBe('none');
    expect(classifyReleasesSectionMatch(null, 'v0.15.0')).toBe('none');
  });
});
