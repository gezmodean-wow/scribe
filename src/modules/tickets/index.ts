import type { Client } from 'discord.js';
import type { Config } from '../../core/config.js';
import type { Database } from '../../core/db/client.js';
import type { GithubClient } from '../../core/github.js';
import type { HttpServer } from '../../core/http.js';
import type { Logger } from '../../core/logger.js';
import { registerGithubWebhooks } from './github-webhooks.js';
import { registerTicketsInteractions } from './interactions.js';
import { registerMirror } from './mirror.js';

export type TicketsModuleDeps = {
  log: Logger;
  http: HttpServer;
  config: Config;
  db: Database;
  github: GithubClient;
  discord: Client;
};

export function registerTicketsModule(deps: TicketsModuleDeps) {
  registerGithubWebhooks(deps);
  registerTicketsInteractions(deps);
  registerMirror(deps);
  deps.log.info('Tickets module registered');
}
