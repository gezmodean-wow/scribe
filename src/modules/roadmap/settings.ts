import { eq } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { appSettings, type AppSettings } from '../../core/db/schema.js';

// Accessors for the `app_settings` singleton (issue #10). The table holds at
// most one row, enforced by the `id = 1` CHECK in drizzle/0009; callers never
// pass an id. No row exists until `/scribe-roadmap-aggregate-set` seeds one.

const SINGLETON_ID = 1;

export async function getAppSettings(
  db: Database
): Promise<AppSettings | undefined> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, SINGLETON_ID))
    .limit(1);
  return rows[0];
}

// Upserts the suite-wide aggregate `#roadmap` channel id. Passing null clears
// it (the aggregate render then becomes a no-op until a channel is set again).
export async function setRoadmapAggregateChannel(
  db: Database,
  channelId: string | null
): Promise<AppSettings> {
  const [row] = await db
    .insert(appSettings)
    .values({
      id: SINGLETON_ID,
      roadmapAggregateChannelId: channelId,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { roadmapAggregateChannelId: channelId, updatedAt: new Date() },
    })
    .returning();
  return row!;
}
