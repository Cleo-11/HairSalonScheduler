import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createMessaging } from './messaging/index.js';
import { Sweeper } from './queue/sweeper.js';
import { RealtimeHub } from './realtime.js';
import { seedDemo } from './seed.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

// Demo hosting: put the demo salon in an empty database so the site works on first deploy.
// Never touches a database that already has a salon.
if (config.DEMO_MODE) {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM salons');
  if (rows[0]!.n === 0) await seedDemo(db, { password: config.SEED_STAFF_PASSWORD, log: console.log });
}
const hub = new RealtimeHub(config.DATABASE_URL, (m) => console.warn(m));
await hub.start();

const { app, deps } = await buildApp({ config, db, hub, messaging: createMessaging(config), logger: true });
const sweeper = new Sweeper(db, deps.queue, config.SWEEP_INTERVAL_MS, (m) => app.log.warn(m));
sweeper.start();

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`OTP provider: ${config.OTP_PROVIDER}, notifications: ${config.NOTIFY_PROVIDER}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    sweeper.stop();
    await app.close();
    await hub.stop();
    await db.end();
    process.exit(0);
  });
}
