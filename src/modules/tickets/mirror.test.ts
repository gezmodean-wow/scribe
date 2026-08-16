import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  chunkForDiscord,
  extractDiscordAuthorId,
  formatDiscordForGithub,
} from './mirror.js';

// Minimal stand-in for the pino logger the formatter takes; nothing in these
// cases hits the attachment-fetch path that would log.
const log = { warn: () => {} } as unknown as Parameters<
  typeof formatDiscordForGithub
>[1];

function fakeMessage(over: {
  id: string;
  username: string;
  content: string;
}): Message {
  return {
    author: { id: over.id, username: over.username },
    content: over.content,
    attachments: new Map(),
  } as unknown as Message;
}

describe('formatDiscordForGithub', () => {
  it('carries the Discord author id as a hidden marker (issue #12)', async () => {
    const body = await formatDiscordForGithub(
      fakeMessage({
        id: '285276455699742720',
        username: 'shylynce',
        content: 'gold withdrawal is off by one',
      }),
      log
    );

    expect(body).toContain('**shylynce** (via Discord):');
    expect(body).toContain('gold withdrawal is off by one');
    expect(body).toContain('<!-- discord-author: 285276455699742720 -->');
    // Hidden, not rendered: the id must not appear as a live mention that
    // GitHub would show, and must not read as text in the comment body.
    expect(body).not.toContain('<@285276455699742720>');
  });

  it('round-trips through extractDiscordAuthorId', async () => {
    const body = await formatDiscordForGithub(
      fakeMessage({ id: '42', username: 'crameroni', content: 'repro steps' }),
      log
    );
    expect(extractDiscordAuthorId(body)).toBe('42');
  });

  it('returns null when a comment carries no marker', () => {
    expect(extractDiscordAuthorId('## Player update\n\nFixed in v0.14.0')).toBe(
      null
    );
  });
});

describe('chunkForDiscord', () => {
  it('returns a single chunk when the text fits', () => {
    expect(chunkForDiscord('short', 100, 100)).toEqual(['short']);
  });

  it('prefers paragraph boundaries when splitting', () => {
    const text = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60);
    const chunks = chunkForDiscord(text, 80, 80);
    expect(chunks).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
  });
});
