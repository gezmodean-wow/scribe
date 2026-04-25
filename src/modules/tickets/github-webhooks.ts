import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TicketsModuleDeps } from './index.js';
import { handleGithubMirror } from './mirror.js';

const SIGNATURE_HEADER = 'x-hub-signature-256';

export function registerGithubWebhooks(deps: TicketsModuleDeps) {
  const { http, log, config } = deps;

  http.post('/webhooks/github', async (request, reply) => {
    const rawSig = request.headers[SIGNATURE_HEADER];
    const signature = Array.isArray(rawSig) ? rawSig[0] : rawSig;

    if (
      !isValidSignature(
        config.github.webhookSecret,
        request.rawBody ?? '',
        signature
      )
    ) {
      log.warn('github webhook signature invalid');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const event = request.headers['x-github-event'];
    const deliveryId = request.headers['x-github-delivery'];
    const payload = request.body as unknown;
    const action = (payload as { action?: string } | undefined)?.action;

    log.info({ event, deliveryId, action }, 'github webhook received');

    // Acknowledge immediately; mirror work runs after the reply so a slow
    // Discord API call can't stall GitHub into retrying.
    if (typeof event === 'string') {
      setImmediate(() => {
        handleGithubMirror(event, payload, deps).catch((err) => {
          log.error(
            { err, event, deliveryId },
            'github webhook processing failed'
          );
        });
      });
    }

    return { ok: true };
  });
}

function isValidSignature(
  secret: string,
  rawBody: string,
  signature: string | undefined
): boolean {
  if (!signature) return false;
  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
