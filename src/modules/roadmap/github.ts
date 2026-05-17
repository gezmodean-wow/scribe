import type { TicketsModuleDeps } from '../tickets/index.js';
import {
  classifyMilestoneKind,
  type CogRoadmap,
  type RoadmapMilestone,
} from './render.js';

// GitHub read layer for the roadmap module (issue #10). GitHub milestones are
// the source of truth (per `roadmap-and-version-broadcast.md`); this module
// turns them into the `CogRoadmap` shape the renderer consumes.

// How many inline issue titles the pin shows. We over-fetch slightly so that
// filtering out pull requests still leaves enough real issues.
const INLINE_TITLE_FETCH = 8;
const INLINE_TITLE_KEEP = 3;

// Fetches every open milestone for a cog repo plus a few inline open-issue
// titles for each version milestone. Backlog / "other" milestones render
// collapsed (count only), so they don't need the title fetch.
export async function fetchCogRoadmap(
  owner: string,
  repo: string,
  deps: TicketsModuleDeps
): Promise<CogRoadmap> {
  const milestones = await deps.github.paginate(
    deps.github.rest.issues.listMilestones,
    { owner, repo, state: 'open', per_page: 100 }
  );

  const result: RoadmapMilestone[] = [];
  for (const ms of milestones) {
    const kind = classifyMilestoneKind(ms.title);
    const openIssueTitles =
      kind === 'version'
        ? await fetchMilestoneIssueTitles(owner, repo, ms.number, deps)
        : [];
    result.push({
      title: ms.title,
      htmlUrl: ms.html_url,
      openCount: ms.open_issues,
      closedCount: ms.closed_issues,
      kind,
      openIssueTitles,
    });
  }
  return { milestones: result };
}

async function fetchMilestoneIssueTitles(
  owner: string,
  repo: string,
  milestoneNumber: number,
  deps: TicketsModuleDeps
): Promise<string[]> {
  const { data } = await deps.github.rest.issues.listForRepo({
    owner,
    repo,
    milestone: String(milestoneNumber),
    state: 'open',
    sort: 'created',
    direction: 'asc',
    per_page: INLINE_TITLE_FETCH,
  });
  // listForRepo returns issues and PRs; PRs aren't player-facing reports.
  return data
    .filter((i) => !('pull_request' in i && i.pull_request))
    .slice(0, INLINE_TITLE_KEEP)
    .map((i) => i.title);
}

// Derives the milestone an issue carried *before* the change that just fired.
// The `milestoned` webhook payload has no `changes` block, so we read the
// issue's event log: milestone events are chronological, the trailing one is
// the change we're handling, and the one before it is the prior state.
//
// `currentTitle` is the milestone the webhook reports as current; we use it to
// skip the trailing event(s) that represent this change, tolerating GitHub's
// eventual consistency (the just-fired event may or may not be listed yet).
//
// Returns null on any error — the caller degrades to a "first time" message
// rather than failing the notification.
export async function fetchPreviousMilestone(
  owner: string,
  repo: string,
  issueNumber: number,
  currentTitle: string,
  deps: TicketsModuleDeps
): Promise<string | null> {
  try {
    const { data: events } = await deps.github.rest.issues.listEvents({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    type MilestoneEvent = { event: string; title: string | null };
    const milestoneEvents: MilestoneEvent[] = events
      .filter((e) => e.event === 'milestoned' || e.event === 'demilestoned')
      .map((e) => ({
        event: e.event,
        title:
          (e as { milestone?: { title?: string } }).milestone?.title ?? null,
      }));

    let idx = milestoneEvents.length - 1;
    // Drop the trailing event if it's this very change (milestoned → current).
    if (
      idx >= 0 &&
      milestoneEvents[idx]!.event === 'milestoned' &&
      milestoneEvents[idx]!.title === currentTitle
    ) {
      idx--;
    }
    if (idx < 0) return null;

    const prior = milestoneEvents[idx]!;
    // A `demilestoned` prior event means the issue had no milestone right
    // before this change — treat as first-time milestoning.
    return prior.event === 'milestoned' ? prior.title : null;
  } catch (err) {
    deps.log.warn(
      { err, issue: `${owner}/${repo}#${issueNumber}` },
      'roadmap: could not resolve previous milestone'
    );
    return null;
  }
}
