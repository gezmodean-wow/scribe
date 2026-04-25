import { z } from 'zod';

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  discord: z.object({
    token: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
    appId: z.string().min(1, 'DISCORD_APP_ID is required'),
    guildId: z.string().min(1, 'DISCORD_GUILD_ID is required'),
    staffRoleIds: z
      .string()
      .min(1, 'DISCORD_STAFF_ROLE_IDS is required')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      )
      .refine(
        (arr) => arr.length > 0,
        'DISCORD_STAFF_ROLE_IDS must contain at least one role ID'
      ),
  }),
  github: z.object({
    appId: z.string().min(1, 'GITHUB_APP_ID is required'),
    privateKey: z.string().min(1, 'GITHUB_APP_PRIVATE_KEY is required'),
    installationId: z.string().min(1, 'GITHUB_APP_INSTALLATION_ID is required'),
    webhookSecret: z.string().min(1, 'GITHUB_WEBHOOK_SECRET is required'),
  }),
  db: z.object({
    url: z.string().url('DATABASE_URL must be a valid URL'),
  }),
  http: z.object({
    port: z.coerce.number().int().positive().default(3000),
    host: z.string().default('0.0.0.0'),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    discord: {
      token: process.env.DISCORD_BOT_TOKEN,
      appId: process.env.DISCORD_APP_ID,
      guildId: process.env.DISCORD_GUILD_ID,
      staffRoleIds: process.env.DISCORD_STAFF_ROLE_IDS,
    },
    github: {
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    },
    db: {
      url: process.env.DATABASE_URL,
    },
    http: {
      port: process.env.HTTP_PORT ?? process.env.PORT,
      host: process.env.HTTP_HOST,
    },
  });
  if (!parsed.success) {
    console.error('Config validation failed:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
