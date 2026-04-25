import { App } from 'octokit';
import type { Config } from './config.js';

export async function createGithubClient(config: Config) {
  const app = new App({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
  });
  const installationId = Number(config.github.installationId);
  return app.getInstallationOctokit(installationId);
}

export type GithubClient = Awaited<ReturnType<typeof createGithubClient>>;
