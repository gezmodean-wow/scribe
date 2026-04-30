// Extracts player-facing text an engineer wrote inside a markdown body.
//
// Two recognized headings, each with its own audience:
//   - `## Player summary` lives in an issue body. Pulled into the close
//     announcement and the next release announcement's "What changed" list.
//   - `## Player update` lives in a GitHub issue comment. Gates whether the
//     comment is mirrored to Discord at all (engineering chatter stays out).
//
// First paragraph (up to the first blank line) is returned, trimmed. Returns
// null when the heading is absent or the section is empty.

const SUMMARY_HEADING_RE = /^##\s+player\s+summary\s*$/im;
const UPDATE_HEADING_RE = /^##\s+player\s+update\s*$/im;

export function extractPlayerSummary(
  body: string | null | undefined
): string | null {
  return extractSection(body, SUMMARY_HEADING_RE);
}

export function extractPlayerUpdate(
  body: string | null | undefined
): string | null {
  return extractSection(body, UPDATE_HEADING_RE);
}

function extractSection(
  body: string | null | undefined,
  headingRe: RegExp
): string | null {
  if (!body) return null;
  const match = headingRe.exec(body);
  if (!match) return null;
  const after = body.slice(match.index + match[0].length);
  // Cut at the next markdown heading at any level so we don't bleed into the
  // following section. Ignore '#' inside code fences for simplicity.
  const nextHeading = /\n#{1,6}\s+\S/.exec(after);
  const region = nextHeading ? after.slice(0, nextHeading.index) : after;
  return firstParagraph(region);
}

function firstParagraph(s: string): string | null {
  const trimmed = s.replace(/^\s+/, '');
  if (!trimmed) return null;
  const blankLine = trimmed.search(/\r?\n\s*\r?\n/);
  const paragraph = blankLine === -1 ? trimmed : trimmed.slice(0, blankLine);
  const collapsed = paragraph.replace(/\s+/g, ' ').trim();
  return collapsed || null;
}
