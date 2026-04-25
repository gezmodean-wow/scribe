import Fastify from 'fastify';
import type { Logger } from './logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function createHttpServer(log: Logger) {
  const app = Fastify({ loggerInstance: log });

  // Preserve the raw body on every JSON request so webhook handlers can
  // HMAC-verify signatures against the exact bytes GitHub sent.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as unknown as { rawBody?: string }).rawBody = body as string;
      if (!body) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}

export type HttpServer = ReturnType<typeof createHttpServer>;
