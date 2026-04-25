import {
  REST,
  type RESTPostAPIApplicationCommandsJSONBody,
  Routes,
} from 'discord.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export async function registerGuildCommands(
  config: Config,
  commands: RESTPostAPIApplicationCommandsJSONBody[],
  log: Logger
) {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  await rest.put(
    Routes.applicationGuildCommands(
      config.discord.appId,
      config.discord.guildId
    ),
    { body: commands }
  );
  log.info({ count: commands.length }, 'Slash commands registered');
}
