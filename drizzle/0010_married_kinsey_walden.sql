ALTER TABLE "release_announcements" ADD COLUMN "promoted_from_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_issue_map" ADD COLUMN "first_released_tag" varchar(100);--> statement-breakpoint
ALTER TABLE "thread_issue_map" ADD COLUMN "first_released_channel" varchar(16);--> statement-breakpoint
ALTER TABLE "thread_issue_map" ADD COLUMN "first_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thread_issue_map" ADD COLUMN "promoted_to_stable_tag" varchar(100);--> statement-breakpoint
ALTER TABLE "thread_issue_map" ADD COLUMN "promoted_to_stable_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "thread_issue_map_first_released_idx" ON "thread_issue_map" USING btree ("github_owner","github_repo","first_released_tag");