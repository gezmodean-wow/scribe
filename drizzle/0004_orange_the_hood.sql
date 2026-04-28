CREATE TABLE "release_announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_owner" varchar(64) NOT NULL,
	"github_repo" varchar(100) NOT NULL,
	"tag" varchar(100) NOT NULL,
	"github_release_id" varchar(32),
	"release_url" text NOT NULL,
	"channel" varchar(16) NOT NULL,
	"prerelease" boolean DEFAULT false NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"review_channel_id" varchar(32),
	"review_message_id" varchar(32),
	"announce_channel_id" varchar(32),
	"announce_message_id" varchar(32),
	"draft_body" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cog_channels" ADD COLUMN "release_announce_channel_id" varchar(32);--> statement-breakpoint
ALTER TABLE "cog_channels" ADD COLUMN "release_review_channel_id" varchar(32);--> statement-breakpoint
ALTER TABLE "cog_channels" ADD COLUMN "download_info_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "release_announcements_repo_tag_unique" ON "release_announcements" USING btree ("github_owner","github_repo","tag");