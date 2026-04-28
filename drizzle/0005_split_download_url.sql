ALTER TABLE "cog_channels" DROP COLUMN "download_info_url";--> statement-breakpoint
ALTER TABLE "cog_channels" ADD COLUMN "curseforge_slug" text;--> statement-breakpoint
ALTER TABLE "cog_channels" ADD COLUMN "wago_slug" text;