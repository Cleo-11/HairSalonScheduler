import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { OtpService } from './auth/otp.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import type { Messaging } from './messaging/index.js';
import { QueueService } from './queue/service.js';
import type { RealtimeHub } from './realtime.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { customerQueueRoutes } from './routes/queue.js';
import { salonRoutes } from './routes/salons.js';

export interface Deps {
  config: Config;
  db: Db;
  messaging: Messaging;
  otp: OtpService;
  queue: QueueService;
  hub: RealtimeHub | null;
  now: () => Date;
}

export interface BuildOptions {
  config: Config;
  db: Db;
  messaging: Messaging;
  hub?: RealtimeHub | null;
  now?: () => Date;
  logger?: boolean;
}

export interface RouteInfo {
  method: string;
  url: string;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; deps: Deps; routes: RouteInfo[] }> {
  const now = opts.now ?? (() => new Date());
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    ajv: { customOptions: { coerceTypes: false } },
  });

  const routes: RouteInfo[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url: r.url });
  });

  const log = (m: string) => app.log.warn(m);
  const deps: Deps = {
    config: opts.config,
    db: opts.db,
    messaging: opts.messaging,
    hub: opts.hub ?? null,
    now,
    otp: new OtpService(opts.db, opts.messaging.otp, opts.config, now, {
      log,
      exposeProviderErrors: opts.config.NODE_ENV !== 'production',
      exposeDevCode: opts.config.DEMO_MODE,
    }),
    queue: new QueueService(opts.db, opts.messaging.notifier, now, {
      maxActivePerCustomer: opts.config.MAX_ACTIVE_ENTRIES_PER_CUSTOMER,
      log,
    }),
  };

  await app.register(cors, {
    origin: opts.config.CORS_ORIGINS === '*' ? true : opts.config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    // The default only allows GET/HEAD/POST; the dashboard also uses PATCH, PUT and DELETE.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });
  await app.register(jwt, { secret: opts.config.JWT_SECRET });
  if (opts.config.RATE_LIMIT_ENABLED) await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new AppError(429, 'RATE_LIMITED', `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message, details: null } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong', details: null } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', details: null } }),
  );

  app.get('/health', async () => {
    await opts.db.query('SELECT 1');
    return { ok: true, time: now().toISOString() };
  });

  await authRoutes(app, deps);
  await salonRoutes(app, deps);
  await customerQueueRoutes(app, deps);
  await dashboardRoutes(app, deps);
  return { app, deps, routes };
}
