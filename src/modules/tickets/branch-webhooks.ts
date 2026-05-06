import type { ThreadChannel } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { threadIssueMap } from '../../core/db/schema.js';
import { findCogByRepo } from './channels.js';
import type { TicketsModuleDeps } from './index.js';
import { applyStatusTag } from './status.js';

// Branch convention (canonical reference: cogworks#33):
//   <type>/<COG-N>-<slug>   issue-linked work
//   <type>/<slug>           chore work without an issue
// Issue-less branches intentionally don't match — webhook noop is correct.
const BRANCH_ISSUE_RE = /^[a-z]+\/([A-Z]+)-(\d+)-/;

type CreatePayload = {
  ref: string;
  ref_type: string;
  repository: { name: string; owner: { login: string } };
};

type DeletePayload = CreatePayload;

export async function handleBranchCreate(
  payload: CreatePayload,
  deps: TicketsModuleDeps
): Promise<void> {
  if (payload.ref_type !== 'branch') return;

  const parsed = parseBranchRef(payload.ref);
  if (!parsed) return;

  const cog = await findCogByRepo(
    deps.db,
    payload.repository.owner.login,
    payload.repository.name
  );
  if (!cog) {
    deps.log.debug(
      { repo: `${payload.repository.owner.login}/${payload.repository.name}`, ref: payload.ref },
      'branch-create: repo not linked to a cog, skipping'
    );
    return;
  }

  // The branch's COG-prefix should match the cog's configured prefix. If a
  // dev creates a branch with the wrong prefix (e.g. typo), the issue lookup
  // would 404 anyway — we just log and bail before that.
  if (parsed.prefix !== cog.cogIdPrefix) {
    deps.log.info(
      {
        repo: `${cog.githubOwner}/${cog.githubRepo}`,
        branchPrefix: parsed.prefix,
        configuredPrefix: cog.cogIdPrefix,
        ref: payload.ref,
      },
      'branch-create: branch prefix does not match configured cog prefix, skipping'
    );
    return;
  }

  const thread = await findThreadForIssue(
    payload.repository.owner.login,
    payload.repository.name,
    parsed.issueNumber,
    deps
  );
  if (!thread) {
    deps.log.debug(
      {
        repo: `${cog.githubOwner}/${cog.githubRepo}`,
        issue: parsed.issueNumber,
        ref: payload.ref,
      },
      'branch-create: no linked thread for issue, skipping'
    );
    return;
  }

  // Don't downgrade a closed issue's status if someone re-opens a branch
  // after the fact. The forward-state guard in applyStatusTag already
  // protects in_progress/released, but an issue closed as not_planned
  // should not flip back to in_progress just because a branch was created.
  let issueState: string;
  try {
    const { data } = await deps.github.rest.issues.get({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: parsed.issueNumber,
    });
    issueState = data.state;
  } catch (err) {
    deps.log.warn(
      { err, issue: parsed.issueNumber, ref: payload.ref },
      'branch-create: could not fetch issue state'
    );
    return;
  }
  if (issueState !== 'open') {
    deps.log.info(
      { issue: parsed.issueNumber, issueState, ref: payload.ref },
      'branch-create: issue is not open, leaving status untouched'
    );
    return;
  }

  await applyStatusTag(thread, cog, 'in_progress').catch((err) => {
    deps.log.warn(
      { err, threadId: thread.id, ref: payload.ref },
      'branch-create: could not apply in_progress tag'
    );
  });

  deps.log.info(
    {
      threadId: thread.id,
      issue: `${cog.githubOwner}/${cog.githubRepo}#${parsed.issueNumber}`,
      ref: payload.ref,
    },
    'branch-create: applied in_progress'
  );
}

// Branch deletion is intentionally a noop. Branches get rebased/squashed
// constantly during work; reverting In Progress on delete would flicker.
// Verification fires when the issue closes (whether via merged PR or manual
// close), and that path already strips in_progress via applyStatusTag's
// status-replace semantics.
export async function handleBranchDelete(
  payload: DeletePayload,
  deps: TicketsModuleDeps
): Promise<void> {
  if (payload.ref_type !== 'branch') return;
  const parsed = parseBranchRef(payload.ref);
  if (!parsed) return;
  deps.log.debug(
    {
      repo: `${payload.repository.owner.login}/${payload.repository.name}`,
      ref: payload.ref,
    },
    'branch-delete: noop (in_progress preserved until issue closes)'
  );
}

function parseBranchRef(
  ref: string
): { prefix: string; issueNumber: number } | null {
  const m = ref.match(BRANCH_ISSUE_RE);
  if (!m) return null;
  const issueNumber = Number.parseInt(m[2]!, 10);
  if (Number.isNaN(issueNumber)) return null;
  return { prefix: m[1]!, issueNumber };
}

async function findThreadForIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  deps: TicketsModuleDeps
): Promise<ThreadChannel | null> {
  const [row] = await deps.db
    .select()
    .from(threadIssueMap)
    .where(
      and(
        eq(threadIssueMap.githubOwner, owner),
        eq(threadIssueMap.githubRepo, repo),
        eq(threadIssueMap.githubIssueNumber, issueNumber)
      )
    )
    .limit(1);
  if (!row) return null;

  const channel = await deps.discord.channels
    .fetch(row.discordThreadId)
    .catch(() => null);
  if (!channel?.isThread()) return null;
  return channel as ThreadChannel;
}
