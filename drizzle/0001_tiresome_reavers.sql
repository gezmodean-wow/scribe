CREATE TABLE "cog_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_channel_id" varchar(32) NOT NULL,
	"discord_guild_id" varchar(32) NOT NULL,
	"github_owner" varchar(64) NOT NULL,
	"github_repo" varchar(100) NOT NULL,
	"cog_id_prefix" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cog_channels_discord_channel_id_unique" UNIQUE("discord_channel_id")
);
