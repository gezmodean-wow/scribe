// Promotion detection for the chronoforge release model (issue #3).
//
// The model: channels label *exposure*, not maturity. `v0.14.0-alpha1` and
// `v0.14.0` can be the same build — promotion to stable is a re-tag of the
// same commit, with no code change between. A player already on the alpha
// channel is running the code the stable tag makes default.
//
// Scribe can't tell those apart from the tag name alone, and it matters: a
// straight "Fixed in v0.14.0" announcement for a promotion re-announces work
// players already have, and the per-thread followup says the wrong thing. So
// we resolve prior prerelease tags of the same version to their commit SHAs
// and compare.
//
// Split into pure selection/comparison helpers (unit-tested) and the two IO
// entry points that talk to GitHub and Postgres.

import { and, eq, inArray } from 'drizzle-orm';
import { releaseAnnouncements, threadIssueMap } from '../../core/db/schema.js';
import type { TicketsModuleDeps } from './index.js';
import { isPrereleaseTag, parseReleaseTag } from './release-notes.js';

export type PromotionInfo = {
  // Every prior prerelease tag of this same version, newest-known first. The
  // full set is the promotion cohort — see `sameCommitTags` for why this is
  // wider than the SHA match.
  priorPrereleaseTags: string[];
  // The subset that sits on the exact commit this tag points at. Non-empty is
  // what makes this release a promotion rather than new code.
  sameCommitTags: string[];
};

// Same `MAJOR.MINOR.PATCH`, ignoring any prerelease suffix — `v0.14.0-alpha2`
// and `v0.14.0` are the same version, one exposed to a narrower audience.
// Unparseable tags are never "the same line" rather than guessed at, matching
// how `decideRenderMode` degrades.
export function isSameVersionLine(a: string, b: string): boolean {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (!pa || !pb) return false;
  return pa.major === pb.major && pa.minor === pb.minor && pa.patch === pb.patch;
}

// Prior tags that belong to the same version as `thisTag` and carry a
// prerelease suffix.
export function selectPriorPrereleaseTags(
  thisTag: string,
  candidateTags: string[]
): string[] {
  const parsed = parseReleaseTag(thisTag);
  if (!parsed || isPrereleaseTag(parsed)) return [];

  return candidateTags.filter((tag) => {
    if (tag === thisTag) return false;
    const p = parseReleaseTag(tag);
    if (!p || !isPrereleaseTag(p)) return false;
    return isSameVersionLine(thisTag, tag);
  });
}

// Which of `tags` resolve to `thisSha`. Tags whose SHA we couldn't resolve are
// absent from the map and simply don't match — a lookup failure degrades to
// "not a promotion", which renders the historical (newly-fixed) framing.
export function tagsAtSameCommit(
  thisSha: string | null,
  tags: string[],
  shaByTag: Map<string, string>
): string[] {
  if (!thisSha) return [];
  return tags.filter((t) => shaByTag.get(t) === thisSha);
}

export function isPromotion(info: PromotionInfo | null): boolean {
  return Boolean(info && info.sameCommitTags.length > 0);
}

// Resolves a tag to the commit it points at. `repos.getCommit` follows
// annotated tag objects server-side, so this works for both lightweight and
// annotated tags without a manual deref.
async function resolveTagSha(
  owner: string,
  repo: string,
  tag: string,
  deps: TicketsModuleDeps
): Promise<string | null> {
  try {
    const { data } = await deps.github.rest.repos.getCommit({
      owner,
      repo,
      ref: tag,
    });
    return data.sha;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      deps.log.warn(
        { err, repo: `${owner}/${repo}`, tag },
        'promotion: could not resolve tag to a commit'
      );
    }
    return null;
  }
}

// Returns null when this tag can't be a promotion at all (prerelease tag,
// unparseable tag, or no prior prereleases of the same version) — callers
// treat null and "no same-commit tags" identically, but null saves the
// GitHub round-trips.
export async function detectPromotion(
  owner: string,
  repo: string,
  thisTag: string,
  deps: TicketsModuleDeps
): Promise<PromotionInfo | null> {
  const rows = await deps.db
    .select({ tag: releaseAnnouncements.tag })
    .from(releaseAnnouncements)
    .where(
      and(
        eq(releaseAnnouncements.githubOwner, owner),
        eq(releaseAnnouncements.githubRepo, repo)
      )
    );

  const priorPrereleaseTags = selectPriorPrereleaseTags(
    thisTag,
    rows.map((r) => r.tag)
  );
  if (priorPrereleaseTags.length === 0) return null;

  const thisSha = await resolveTagSha(owner, repo, thisTag, deps);
  const shaByTag = new Map<string, string>();
  for (const tag of priorPrereleaseTags) {
    const sha = await resolveTagSha(owner, repo, tag, deps);
    if (sha) shaByTag.set(tag, sha);
  }

  const sameCommitTags = tagsAtSameCommit(
    thisSha,
    priorPrereleaseTags,
    shaByTag
  );
  if (sameCommitTags.length === 0) {
    deps.log.debug(
      { repo: `${owner}/${repo}`, tag: thisTag, priorPrereleaseTags },
      'promotion: stable tag is not a re-tag of any prior prerelease'
    );
    return { priorPrereleaseTags, sameCommitTags: [] };
  }

  deps.log.info(
    { repo: `${owner}/${repo}`, tag: thisTag, sameCommitTags },
    'promotion: stable tag re-tags a prior prerelease commit'
  );
  return { priorPrereleaseTags, sameCommitTags };
}

// Issue numbers whose *first* release announcement was one of `tags`.
//
// Deliberately keyed on the full prior-prerelease set rather than only the
// same-commit tags: promoting `v0.14.0` makes the whole `v0.14.0` line the
// default install, so an issue first shipped in `-alpha1` belongs in the
// promoted cohort even when the SHA match came from `-alpha2`. Narrowing to
// same-commit tags would silently drop those issues from the announcement —
// they'd appear in neither section.
export async function loadPromotedIssueNumbers(
  owner: string,
  repo: string,
  tags: string[],
  deps: TicketsModuleDeps
): Promise<number[]> {
  if (tags.length === 0) return [];
  const rows = await deps.db
    .select({ number: threadIssueMap.githubIssueNumber })
    .from(threadIssueMap)
    .where(
      and(
        eq(threadIssueMap.githubOwner, owner),
        eq(threadIssueMap.githubRepo, repo),
        inArray(threadIssueMap.firstReleasedTag, tags)
      )
    );
  return rows.map((r) => r.number).sort((a, b) => a - b);
}
