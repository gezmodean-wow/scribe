// Extracts the player-facing summary an engineer wrote for an issue.
//
// Two recognized sources, in order:
//   1. A `## Player summary` (or `## Player Summary`) section in the issue body.
//   2. A fenced ```release-notes ... ``` block in the closing comment.
// First paragraph (up to the first blank line) is returned, trimmed.
//
// Returns null if neither source has usable text — caller decides whether to
// surface a "no summary written" warning or just fall back to the title.

const HEADING_RE = /^##\s+player\s+summary\s*$/im;
const FENCE_RE = /```release-notes\s*\r?\n([\s\S]*?)```/i;

export function extractPlayerSummary(input: {
  body?: string | null;
  closingComment?: string | null;
}): string | null {
  const fromBody = extractFromBody(input.body);
  if (fromBody) return fromBody;
  const fromComment = extractFromFencedBlock(input.closingComment);
  if (fromComment) return fromComment;
  return null;
}

function extractFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = HEADING_RE.exec(body);
  if (!match) return null;
  const after = body.slice(match.index + match[0].length);
  // Cut at the next markdown heading at any level so we don't bleed into the
  // following section. Ignore '#' inside code fences for simplicity.
  const nextHeading = /\n#{1,6}\s+\S/.exec(after);
  const region = nextHeading ? after.slice(0, nextHeading.index) : after;
  return firstParagraph(region);
}

function extractFromFencedBlock(
  text: string | null | undefined
): string | null {
  if (!text) return null;
  const match = FENCE_RE.exec(text);
  if (!match) return null;
  return firstParagraph(match[1] ?? '');
}

function firstParagraph(s: string): string | null {
  const trimmed = s.replace(/^\s+/, '');
  if (!trimmed) return null;
  const blankLine = trimmed.search(/\r?\n\s*\r?\n/);
  const paragraph = blankLine === -1 ? trimmed : trimmed.slice(0, blankLine);
  const collapsed = paragraph.replace(/\s+/g, ' ').trim();
  return collapsed || null;
}
