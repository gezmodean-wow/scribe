CREATE TABLE "thread_transcripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_thread_id" varchar(32) NOT NULL,
	"discord_message_id" varchar(32) NOT NULL,
	"discord_author_id" varchar(32) NOT NULL,
	"discord_author_name" varchar(100) NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"attachments_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"promoted_at" timestamp with time zone,
	"promoted_by" varchar(32),
	"github_comment_id" varchar(32),
	CONSTRAINT "thread_transcripts_discord_message_id_unique" UNIQUE("discord_message_id")
);
--> statement-breakpoint
CREATE INDEX "thread_transcripts_thread_created_idx" ON "thread_transcripts" USING btree ("discord_thread_id","created_at");