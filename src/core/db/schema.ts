import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

export const threadIssueMap = pgTable(
  'thread_issue_map',
  {
    id: serial('id').primaryKey(),
    discordThreadId: varchar('discord_thread_id', { length: 32 })
      .notNull()
      .unique(),
    discordChannelId: varchar('discord_channel_id', { length: 32 }).notNull(),
    discordGuildId: varchar('discord_guild_id', { length: 32 }).notNull(),
    githubOwner: varchar('github_owner', { length: 64 }).notNull(),
    githubRepo: varchar('github_repo', { length: 100 }).notNull(),
    githubIssueNumber: integer('github_issue_number').notNull(),
    githubIssueNodeId: varchar('github_issue_node_id', {
      length: 64,
    }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('thread_issue_map_issue_unique').on(
      t.githubOwner,
      t.githubRepo,
      t.githubIssueNumber
    ),
  ]
);

export type ThreadIssueMap = typeof threadIssueMap.$inferSelect;
export type NewThreadIssueMap = typeof threadIssueMap.$inferInsert;

export const cogChannels = pgTable('cog_channels', {
  id: serial('id').primaryKey(),
  discordChannelId: varchar('discord_channel_id', { length: 32 })
    .notNull()
    .unique(),
  discordGuildId: varchar('discord_guild_id', { length: 32 }).notNull(),
  githubOwner: varchar('github_owner', { length: 64 }).notNull(),
  githubRepo: varchar('github_repo', { length: 100 }).notNull(),
  cogIdPrefix: varchar('cog_id_prefix', { length: 16 }).notNull(),
  tagLabelMap: jsonb('tag_label_map')
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  statusTagMap: jsonb('status_tag_map')
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  releaseAnnounceChannelId: varchar('release_announce_channel_id', {
    length: 32,
  }),
  releaseReviewChannelId: varchar('release_review_channel_id', { length: 32 }),
  downloadInfoUrl: text('download_info_url'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type CogChannel = typeof cogChannels.$inferSelect;
export type NewCogChannel = typeof cogChannels.$inferInsert;

export const releaseAnnouncements = pgTable(
  'release_announcements',
  {
    id: serial('id').primaryKey(),
    githubOwner: varchar('github_owner', { length: 64 }).notNull(),
    githubRepo: varchar('github_repo', { length: 100 }).notNull(),
    tag: varchar('tag', { length: 100 }).notNull(),
    githubReleaseId: varchar('github_release_id', { length: 32 }),
    releaseUrl: text('release_url').notNull(),
    channel: varchar('channel', { length: 16 }).notNull(),
    prerelease: boolean('prerelease').notNull().default(false),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    reviewChannelId: varchar('review_channel_id', { length: 32 }),
    reviewMessageId: varchar('review_message_id', { length: 32 }),
    announceChannelId: varchar('announce_channel_id', { length: 32 }),
    announceMessageId: varchar('announce_message_id', { length: 32 }),
    draftBody: text('draft_body').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('release_announcements_repo_tag_unique').on(
      t.githubOwner,
      t.githubRepo,
      t.tag
    ),
  ]
);

export type ReleaseAnnouncement = typeof releaseAnnouncements.$inferSelect;
export type NewReleaseAnnouncement = typeof releaseAnnouncements.$inferInsert;
