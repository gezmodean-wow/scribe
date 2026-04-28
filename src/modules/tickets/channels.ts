import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { cogChannels, type CogChannel } from '../../core/db/schema.js';

export type { CogChannel };

export async function findCogForChannel(
  db: Database,
  discordChannelId: string
): Promise<CogChannel | undefined> {
  const rows = await db
    .select()
    .from(cogChannels)
    .where(eq(cogChannels.discordChannelId, discordChannelId))
    .limit(1);
  return rows[0];
}

export async function linkChannel(
  db: Database,
  input: {
    discordChannelId: string;
    discordGuildId: string;
    githubOwner: string;
    githubRepo: string;
    cogIdPrefix: string;
  }
): Promise<CogChannel> {
  const [row] = await db
    .insert(cogChannels)
    .values(input)
    .onConflictDoUpdate({
      target: cogChannels.discordChannelId,
      set: {
        githubOwner: input.githubOwner,
        githubRepo: input.githubRepo,
        cogIdPrefix: input.cogIdPrefix,
        discordGuildId: input.discordGuildId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

export async function unlinkChannel(
  db: Database,
  discordChannelId: string
): Promise<CogChannel | undefined> {
  const [row] = await db
    .delete(cogChannels)
    .where(eq(cogChannels.discordChannelId, discordChannelId))
    .returning();
  return row;
}

export async function listChannels(db: Database): Promise<CogChannel[]> {
  return db.select().from(cogChannels).orderBy(asc(cogChannels.cogIdPrefix));
}

export async function setTagMapping(
  db: Database,
  discordChannelId: string,
  tagId: string,
  label: string
): Promise<CogChannel | undefined> {
  const cog = await findCogForChannel(db, discordChannelId);
  if (!cog) return undefined;
  const next = { ...cog.tagLabelMap, [tagId]: label };
  const [row] = await db
    .update(cogChannels)
    .set({ tagLabelMap: next, updatedAt: new Date() })
    .where(eq(cogChannels.discordChannelId, discordChannelId))
    .returning();
  return row;
}

export async function unsetTagMapping(
  db: Database,
  discordChannelId: string,
  tagId: string
): Promise<CogChannel | undefined> {
  const cog = await findCogForChannel(db, discordChannelId);
  if (!cog) return undefined;
  const next = { ...cog.tagLabelMap };
  delete next[tagId];
  const [row] = await db
    .update(cogChannels)
    .set({ tagLabelMap: next, updatedAt: new Date() })
    .where(eq(cogChannels.discordChannelId, discordChannelId))
    .returning();
  return row;
}

export async function setStatusMapping(
  db: Database,
  discordChannelId: string,
  statusKey: string,
  tagId: string
): Promise<CogChannel | undefined> {
  const cog = await findCogForChannel(db, discordChannelId);
  if (!cog) return undefined;
  const next = { ...cog.statusTagMap, [statusKey]: tagId };
  const [row] = await db
    .update(cogChannels)
    .set({ statusTagMap: next, updatedAt: new Date() })
    .where(eq(cogChannels.discordChannelId, discordChannelId))
    .returning();
  return row;
}

export async function replaceMappings(
  db: Database,
  discordChannelId: string,
  tagLabelMap: Record<string, string>,
  statusTagMap: Record<string, string>
): Promise<CogChannel | undefined> {
  const [row] = await db
    .update(cogChannels)
    .set({ tagLabelMap, statusTagMap, updatedAt: new Date() })
    .where(eq(cogChannels.discordChannelId, discordChannelId))
    .returning();
  return row;
}

export async function unsetStatusMapping(
  db: Database,
  discordChannelId: string,
  statusKey: string
): Promise<CogChannel | undefined> {
  const cog = await findCogForChannel(db, discordChannelId);
  if (!cog) return undefined;
  const next = { ...cog.statusTagMap };
  delete next[statusKey];
  const [row] = await db
    .update(cogChannels)
    .set({ statusTagMap: next, updatedAt: new Date() })
    .where(eq(cogChannels.discordChannelId, discordChannelId))
    .returning();
  return row;
}

export async function setReleaseConfig(
  db: Database,
  discordChannelId: string,
  fields: {
    releaseAnnounceChannelId?: string | null;
    releaseReviewChannelId?: string | null;
    curseforgeSlug?: string | null;
    wagoSlug?: string | null;
  }
): Promise<CogChannel | undefined> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (fields.releaseAnnounceChannelId !== undefined) {
    set.releaseAnnounceChannelId = fields.releaseAnnounceChannelId;
  }
  if (fields.releaseReviewChannelId !== undefined) {
    set.releaseReviewChannelId = fields.releaseReviewChannelId;
  }
  if (fields.curseforgeSlug !== undefined) {
    set.curseforgeSlug = fields.curseforgeSlug;
  }
  if (fields.wagoSlug !== undefined) {
    set.wagoSlug = fields.wagoSlug;
  }
  const [row] = await db
    .update(cogChannels)
    .set(set)
    .where(eq(cogChannels.discordChannelId, discordChannelId))
    .returning();
  return row;
}

export async function findCogByRepo(
  db: Database,
  githubOwner: string,
  githubRepo: string
): Promise<CogChannel | undefined> {
  const rows = await db
    .select()
    .from(cogChannels)
    .where(
      and(
        eq(cogChannels.githubOwner, githubOwner),
        eq(cogChannels.githubRepo, githubRepo)
      )
    )
    .limit(1);
  return rows[0];
}
