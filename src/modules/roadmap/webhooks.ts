import type { ThreadChannel } from 'discord.js';
import { findCogByRepo } from '../tickets/channels.js';
import type { TicketsModuleDeps } from '../tickets/index.js';
import { findThreadAndCog } from '../tickets/mirror.js';
import { fetchPreviousMilestone } from './github.js';
import { renderCogRoadmap } from './pins.js';
import {
  classifyMilestoneTransition,
  renderTransitionMessage,
} from './transitions.js';

// Webhook dispatch for the roadmap module (issue #10). Called from
// `mirror.ts:handleGithubMirror` for the `milestone` event and for the
// `issues` actions the roadmap cares about. See the "Update triggers" table
// in `roadmap-and-version-broadcast.md`.

type MilestonePayload = {
  action: string;
  repository: { name: string; owner: { login: string } };
};

type IssueMilestonePayload = {
  action: string;
  issue: {
    number: number;
    milestone?: { title: string } | null;
  };
  repository: { name: string; owner: { login: string } };
};

// `issues` actions that change a milestone's progress counts and so warrant a
// pin re-render. `milestoned`/`demilestoned` additionally drive the per-thread
// notification; `opened`/`closed`/`reopened` only shift the done/total tally.
const RENDER_TRIGGERING_ISSUE_ACTIONS = new Set([
  'milestoned',
  'demilestoned',
  'opened',
  'closed',
  'reopened',
]);

export async function dispatchRoadmapEvent(
  event: string,
  payload: unknown,
  deps: TicketsModuleDeps
): Promise<void> {
  if (event === 'milestone') {
    // created / edited / opened / closed / deleted all shift the pin.
    await renderRepoRoadmap(payload as MilestonePayload, deps);
    return;
  }
  if (event === 'issues') {
    const p = payload as IssueMilestonePayload;
    if (p.action === 'milestoned' || p.action === 'demilestoned') {
      await postMilestoneNotification(p, deps);
    }
    if (RENDER_TRIGGERING_ISSUE_ACTIONS.has(p.action)) {
      await renderRepoRoadmap(p, deps);
    }
  }
}

// Re-renders the cog's roadmap pins for the repo named in the payload.
// `renderCogRoadmap` is itself gated on the rollout flag, so an unlinked or
// not-yet-opted-in repo costs only the cog lookup.
async function renderRepoRoadmap(
  payload: MilestonePayload | IssueMilestonePayload,
  deps: TicketsModuleDeps
): Promise<void> {
  const cog = await findCogByRepo(
    deps.db,
    payload.repository.owner.login,
    payload.repository.name
  );
  if (!cog) return;
  await renderCogRoadmap(cog, deps);
}

// Posts the per-thread milestone-transition notification. Silently skips when
// the issue has no Discord thread mapping — chronoforge meta-tickets (CF-N)
// and any unbridged repo deliberately don't bridge, per the runbook.
async function postMilestoneNotification(
  payload: IssueMilestonePayload,
  deps: TicketsModuleDeps
): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  const next = payload.issue.milestone?.title ?? null;
  // Resolving the previous milestone needs an API call; skip it entirely for
  // demilestoned events (next is null → the transition is always 'none').
  const prev = next
    ? await fetchPreviousMilestone(owner, repo, payload.issue.number, next, deps)
    : null;

  const transition = classifyMilestoneTransition(prev, next);
  if (transition.kind === 'none') return;

  const found = await findThreadAndCog(payload, deps);
  if (!found) return;
  const { thread, cog } = found;

  const message = renderTransitionMessage(cog.githubRepo, transition);
  if (!message) return;

  await sendToThread(thread, message, deps);

  deps.log.info(
    {
      threadId: thread.id,
      issue: `${owner}/${repo}#${payload.issue.number}`,
      transition: transition.kind,
    },
    'roadmap: posted milestone-transition notification'
  );
}

// Sends a line into a player thread, preserving its archived state — Discord
// auto-unarchives a thread on send, so an archived (closed-issue) thread is
// re-archived afterward. Same bracket pattern as mirror.ts.
async function sendToThread(
  thread: ThreadChannel,
  message: string,
  deps: TicketsModuleDeps
): Promise<void> {
  const wasArchived = thread.archived === true;
  try {
    await thread.send(message);
  } catch (err) {
    deps.log.warn(
      { err, threadId: thread.id },
      'roadmap: could not send milestone notification to thread'
    );
    return;
  }
  if (wasArchived) {
    await thread.setArchived(true).catch((err) => {
      deps.log.warn(
        { err, threadId: thread.id },
        'roadmap: could not re-archive thread after notification'
      );
    });
  }
}
