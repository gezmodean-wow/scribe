import { describe, expect, it } from 'vitest';
import {
  classifyMilestoneTransition,
  renderTransitionMessage,
} from './transitions.js';

// Covers the five rows of the per-issue notification table in
// `roadmap-and-version-broadcast.md` (2026-05-07a).

describe('classifyMilestoneTransition', () => {
  it('milestoned to a specific version for the first time', () => {
    expect(classifyMilestoneTransition(null, 'v0.14.0')).toEqual({
      kind: 'version-new',
      next: 'v0.14.0',
    });
  });

  it('milestoned to Backlog for the first time', () => {
    expect(classifyMilestoneTransition(null, 'Backlog')).toEqual({
      kind: 'backlog-new',
    });
  });

  it('re-milestoned from one version to another', () => {
    expect(classifyMilestoneTransition('v0.13.5', 'v0.14.0')).toEqual({
      kind: 'version-moved',
      next: 'v0.14.0',
      prev: 'v0.13.5',
    });
  });

  it('re-milestoned from a version to Backlog', () => {
    expect(classifyMilestoneTransition('v0.14.0', 'Backlog')).toEqual({
      kind: 'backlog-moved',
      prev: 'v0.14.0',
    });
  });

  it('promoted from Backlog to a version', () => {
    expect(classifyMilestoneTransition('Backlog', 'v0.14.0')).toEqual({
      kind: 'version-moved',
      next: 'v0.14.0',
      prev: 'Backlog',
    });
  });

  it('demilestoned entirely emits no message', () => {
    expect(classifyMilestoneTransition('v0.14.0', null)).toEqual({
      kind: 'none',
    });
  });

  it('a no-op re-apply of the same milestone emits no message', () => {
    expect(classifyMilestoneTransition('v0.14.0', 'v0.14.0')).toEqual({
      kind: 'none',
    });
  });

  it('matches Backlog case-insensitively', () => {
    expect(classifyMilestoneTransition(null, 'backlog')).toEqual({
      kind: 'backlog-new',
    });
  });
});

describe('renderTransitionMessage', () => {
  it('renders the version-new line', () => {
    const msg = renderTransitionMessage(
      'tally',
      classifyMilestoneTransition(null, 'v0.14.0')
    );
    expect(msg).toBe('🎯 Targeted for **tally v0.14.0**.');
  });

  it('renders the version-moved line with the prior milestone', () => {
    const msg = renderTransitionMessage(
      'tally',
      classifyMilestoneTransition('v0.13.5', 'v0.14.0')
    );
    expect(msg).toBe(
      '🎯 Now targeted for **tally v0.14.0** (was v0.13.5).'
    );
  });

  it('renders the backlog-new line', () => {
    const msg = renderTransitionMessage(
      'tally',
      classifyMilestoneTransition(null, 'Backlog')
    );
    expect(msg).toBe('📋 Added to the tally backlog.');
  });

  it('renders the backlog-moved line with the prior milestone', () => {
    const msg = renderTransitionMessage(
      'tally',
      classifyMilestoneTransition('v0.14.0', 'Backlog')
    );
    expect(msg).toBe('📋 Moved to the tally backlog (was v0.14.0).');
  });

  it('renders nothing for a none transition', () => {
    const msg = renderTransitionMessage(
      'tally',
      classifyMilestoneTransition('v0.14.0', null)
    );
    expect(msg).toBeNull();
  });
});
