CREATE TABLE "thread_issue_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_thread_id" varchar(32) NOT NULL,
	"discord_channel_id" varchar(32) NOT NULL,
	"discord_guild_id" varchar(32) NOT NULL,
	"github_owner" varchar(64) NOT NULL,
	"github_repo" varchar(100) NOT NULL,
	"github_issue_number" integer NOT NULL,
	"github_issue_node_id" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_issue_map_discord_thread_id_unique" UNIQUE("discord_thread_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "thread_issue_map_issue_unique" ON "thread_issue_map" USING btree ("github_owner","github_repo","github_issue_number");