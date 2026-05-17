import type { TicketsModuleDeps } from '../tickets/index.js';
import { renderAllRoadmaps } from './pins.js';

// Belt-and-suspenders refresh timer (issue #10). The runbook calls for a
// 60-minute re-render of every pinned roadmap message regardless of webhook
// activity — cheap drift recovery when a delivery is missed or scribe was
// offline. A single suite-wide tick renders all opted-in cogs sequentially.

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
// First render shortly after startup so a fresh deploy materializes pins
// without waiting a full hour. The delay lets the Discord client finish
// logging in before the tick fetches channels.
const INITIAL_DELAY_MS = 60 * 1000;

export function startRoadmapRefreshTimer(deps: TicketsModuleDeps): void {
  const tick = () => {
    renderAllRoadmaps(deps).catch((err) => {
      deps.log.error({ err }, 'roadmap: refresh tick failed');
    });
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, REFRESH_INTERVAL_MS);

  deps.log.info(
    { intervalMinutes: REFRESH_INTERVAL_MS / 60_000 },
    'roadmap: refresh timer started'
  );
}
