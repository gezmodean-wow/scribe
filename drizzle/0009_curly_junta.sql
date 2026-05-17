CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"roadmap_aggregate_channel_id" varchar(32),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_single_row" CHECK ("app_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "cog_channels" ADD COLUMN "roadmap_pin_channel_id" varchar(32);--> statement-breakpoint
ALTER TABLE "cog_channels" ADD COLUMN "roadmap_pin_message_id" varchar(32);--> statement-breakpoint
ALTER TABLE "cog_channels" ADD COLUMN "roadmap_aggregate_pin_message_id" varchar(32);