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
