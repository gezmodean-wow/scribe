// Extracts player-facing text an engineer wrote inside a markdown body.
//
// Two recognized headings, each with its own audience and shape:
//   - `## Player summary` lives in an issue body. Pulled into the close
//     announcement and the per-release-thread followup as a one-line bullet,
//     so we collapse to the first paragraph (single line, whitespace squashed).
//   - `## Player update` lives in a GitHub issue comment. Gates whether the
//     comment is mirrored to Discord at all. We return the full section text
//     with markdown formatting preserved — the caller chunks it for Discord —
//     so multi-step instructions, lists, and code blocks survive intact.
//
// Section bound: the next h1 or h2 heading. Sub-sub-headings (h3+) inside the
// section are kept, so an agent can use `### Steps` or similar to structure
// the player-facing content.

const SUMMARY_HEADING_RE = /^##\s+player\s+summary\s*$/im;
const UPDATE_HEADING_RE = /^##\s+player\s+update\s*$/im;

export function extractPlayerSummary(
  body: string | null | undefined
): string | null {
  const region = extractSectionText(body, SUMMARY_HEADING_RE);
  return region ? firstParagraph(region) : null;
}

export function extractPlayerUpdate(
  body: string | null | undefined
): string | null {
  const region = extractSectionText(body, UPDATE_HEADING_RE);
  if (!region) return null;
  const trimmed = region.replace(/^\s+|\s+$/g, '');
  return trimmed || null;
}

function extractSectionText(
  body: string | null | undefined,
  headingRe: RegExp
): string | null {
  if (!body) return null;
  const match = headingRe.exec(body);
  if (!match) return null;
  const after = body.slice(match.index + match[0].length);
  const nextHeading = /\n#{1,2}\s+\S/.exec(after);
  return nextHeading ? after.slice(0, nextHeading.index) : after;
}

function firstParagraph(s: string): string | null {
  const trimmed = s.replace(/^\s+/, '');
  if (!trimmed) return null;
  const blankLine = trimmed.search(/\r?\n\s*\r?\n/);
  const paragraph = blankLine === -1 ? trimmed : trimmed.slice(0, blankLine);
  const collapsed = paragraph.replace(/\s+/g, ' ').trim();
  return collapsed || null;
}

// Pulls the body of a tag's section out of a cog's `RELEASES.md`. The author
// curates this file as player-facing prose; the bot uses the matching section
// as the announce-channel draft body so what Discord shows matches what
// CurseForge / Wago publish via the BigWigs packager's `manual-changelog`.
//
// Heading match order (first hit wins):
//   1. Exact tag, e.g. `## v0.12.0-alpha9`
//   2. Base version with the prerelease suffix stripped, e.g. `## v0.12.0`
//      for tag `v0.12.0-alpha9`. This matches the common pattern of one
//      "in-development" section maintained across an alpha series.
//   3. `## Unreleased`, used in stub files until the dev moves the heading
//      to a real version.
//
// Section bound: next h1 or h2 (so `### Subsection` inside the section is
// preserved). Same trailing-content rule as the player-update extractor.
export function extractReleasesSection(
  body: string | null | undefined,
  tag: string
): string | null {
  if (!body) return null;

  const exact = matchVersionSection(body, tag);
  if (exact) return exact;

  const base = tag.replace(/-(?:alpha|beta|rc)\w*$/i, '');
  if (base !== tag) {
    const baseMatch = matchVersionSection(body, base);
    if (baseMatch) return baseMatch;
  }

  return matchUnreleasedSection(body);
}

function matchVersionSection(body: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match `## <version>` either alone on the line or followed by a non-version
  // qualifier (e.g. `(in development)`). Same-line whitespace is restricted to
  // space/tab — `\s` matches `\n`, which would let the optional tail consume
  // the section's lead paragraph and break extraction. Boundary on the next
  // char keeps `v0.12.0` from matching against `v0.12.0-alpha9`.
  const headingRe = new RegExp(
    `^##[ \\t]+${escaped}(?:[ \\t]+[^\\n]*)?[ \\t]*$`,
    'im'
  );
  return matchSectionBody(body, headingRe);
}

function matchUnreleasedSection(body: string): string | null {
  return matchSectionBody(body, /^##[ \t]+unreleased\b[^\n]*$/im);
}

function matchSectionBody(body: string, headingRe: RegExp): string | null {
  const m = headingRe.exec(body);
  if (!m) return null;
  const after = body.slice(m.index + m[0].length);
  const nextHeading = /\n#{1,2}\s+\S/.exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;
  const trimmed = section.replace(/^\s+|\s+$/g, '');
  return trimmed || null;
}

// Parses a release tag into semver-ish parts. Accepts an optional `v` prefix
// and an optional `-prerelease` suffix (alpha/beta/rc/anything). Returns null
// if the tag doesn't follow `MAJOR.MINOR(.PATCH)?(-PRE)?` so callers can fall
// back to "render full notes" rather than guessing the chain.
export type ParsedTag = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

const TAG_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-(.+))?$/;

export function parseReleaseTag(tag: string): ParsedTag | null {
  const m = TAG_RE.exec(tag.trim());
  if (!m) return null;
  return {
    major: Number.parseInt(m[1]!, 10),
    minor: Number.parseInt(m[2]!, 10),
    patch: m[3] ? Number.parseInt(m[3]!, 10) : 0,
    prerelease: m[4] ?? null,
  };
}

export function isPrereleaseTag(parsed: ParsedTag): boolean {
  return parsed.prerelease !== null && parsed.prerelease.length > 0;
}

export function sameMajorMinor(a: ParsedTag, b: ParsedTag): boolean {
  return a.major === b.major && a.minor === b.minor;
}

// Splits a markdown body into chunks no larger than `maxChars`, preferring
// paragraph boundaries (blank line), falling back to line boundaries, and
// finally to a hard cut. The "boundary too far back" guard prevents tiny
// trailing chunks when a single paragraph happens to land just over the
// limit — better to split mid-paragraph than to emit a 100-char tail.
export function chunkBody(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const minCut = Math.floor(maxChars / 2);
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const head = remaining.slice(0, maxChars);
    let cut = head.lastIndexOf('\n\n');
    if (cut < minCut) cut = head.lastIndexOf('\n');
    if (cut < minCut) cut = maxChars;
    chunks.push(remaining.slice(0, cut).replace(/\s+$/, ''));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
