import { describe, expect, it } from 'vitest';
import {
  isPromotion,
  selectPriorPrereleaseTags,
  tagsAtSameCommit,
} from './promotion.js';

// The chronoforge model these cases encode: promotion is a re-tag of the same
// commit under a stable name (`branch-and-release-flow.md`, 2026-05-06a).

describe('selectPriorPrereleaseTags', () => {
  const tags = [
    'v0.13.0',
    'v0.14.0-alpha1',
    'v0.14.0-alpha2',
    'v0.14.0-beta1',
    'v0.14.1-alpha1',
    'v0.14.0',
  ];

  it('picks prereleases of the same version only', () => {
    expect(selectPriorPrereleaseTags('v0.14.0', tags)).toEqual([
      'v0.14.0-alpha1',
      'v0.14.0-alpha2',
      'v0.14.0-beta1',
    ]);
  });

  it('treats a missing patch as .0 so v0.14 and v0.14.0 line up', () => {
    expect(selectPriorPrereleaseTags('v0.14', ['v0.14.0-alpha1'])).toEqual([
      'v0.14.0-alpha1',
    ]);
  });

  it('returns nothing for a prerelease tag — only stables promote', () => {
    expect(selectPriorPrereleaseTags('v0.14.0-alpha3', tags)).toEqual([]);
  });

  it('returns nothing for an unparseable tag', () => {
    expect(selectPriorPrereleaseTags('nightly', tags)).toEqual([]);
  });

  it('ignores unparseable candidates rather than guessing', () => {
    expect(
      selectPriorPrereleaseTags('v0.14.0', ['nightly', 'v0.14.0-alpha1'])
    ).toEqual(['v0.14.0-alpha1']);
  });
});

describe('tagsAtSameCommit', () => {
  const shas = new Map([
    ['v0.14.0-alpha1', 'aaa'],
    ['v0.14.0-alpha2', 'bbb'],
  ]);

  it('matches the prerelease sitting on the same commit', () => {
    expect(tagsAtSameCommit('bbb', [...shas.keys()], shas)).toEqual([
      'v0.14.0-alpha2',
    ]);
  });

  it('matches every tag on that commit when several point at it', () => {
    const both = new Map([
      ['v0.14.0-alpha1', 'aaa'],
      ['v0.14.0-beta1', 'aaa'],
    ]);
    expect(tagsAtSameCommit('aaa', [...both.keys()], both)).toEqual([
      'v0.14.0-alpha1',
      'v0.14.0-beta1',
    ]);
  });

  it('finds nothing when the stable tag moved past the prereleases', () => {
    expect(tagsAtSameCommit('ccc', [...shas.keys()], shas)).toEqual([]);
  });

  it('degrades to "not a promotion" when this tag\'s sha is unresolvable', () => {
    expect(tagsAtSameCommit(null, [...shas.keys()], shas)).toEqual([]);
  });

  it('skips prereleases whose sha could not be resolved', () => {
    expect(tagsAtSameCommit('aaa', ['v0.14.0-alpha1'], new Map())).toEqual([]);
  });
});

describe('isPromotion', () => {
  it('is false without a same-commit match', () => {
    expect(
      isPromotion({ priorPrereleaseTags: ['v0.14.0-alpha1'], sameCommitTags: [] })
    ).toBe(false);
    expect(isPromotion(null)).toBe(false);
  });

  it('is true with one', () => {
    expect(
      isPromotion({
        priorPrereleaseTags: ['v0.14.0-alpha1'],
        sameCommitTags: ['v0.14.0-alpha1'],
      })
    ).toBe(true);
  });
});
