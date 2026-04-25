import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { loadConfig } from './core/config.js';
import { createDatabase } from './core/db/client.js';
import { createDiscordClient } from './core/discord.js';
import { registerGuildCommands } from './core/discord-commands.js';
import { createGithubClient } from './core/github.js';
import { createHttpServer } from './core/http.js';
import { createLogger } from './core/logger.js';
import { ticketsCommands } from './modules/tickets/commands.js';
import { registerTicketsModule } from './modules/tickets/index.js';

async function main() {
  const config = loadConfig();
  const log = createLogger(config);
  log.info('SCRIBE starting');

  const db = createDatabase(config);
  await db.execute(sql`select 1`);
  log.info('Database connected');

  const github = await createGithubClient(config);
  log.info('GitHub App authenticated');

  const discord = createDiscordClient(log);
  const http = createHttpServer(log);

  registerTicketsModule({ log, http, config, db, github, discord });

  await registerGuildCommands(config, [...ticketsCommands], log);

  await http.listen({ port: config.http.port, host: config.http.host });
  await discord.login(config.discord.token);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    await http.close();
    await discord.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
