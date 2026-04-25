import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { Logger } from './logger.js';

export function createDiscordClient(log: Logger) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  client.on('ready', (c) => {
    log.info({ tag: c.user.tag, guilds: c.guilds.cache.size }, 'Discord ready');
  });

  client.on('error', (err) => {
    log.error({ err }, 'Discord error');
  });

  return client;
}
