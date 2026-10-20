import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { DevMessenger } from '../src/messaging/dev.js';
import { QueueService } from '../src/queue/service.js';
import { salonById } from '../src/salons/repo.js';
import { DEMO, seedDemo } from '../src/seed.js';

// Usage: npm run db:seed [-- --demo-queue]
const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const db = createPool(config.DATABASE_URL);
await seedDemo(db, { password: process.env.SEED_STAFF_PASSWORD, log: console.log });

if (process.argv.includes('--demo-queue')) {
  // A few walk-ins so the dashboard and status screens have something to show.
  const queue = new QueueService(db, new DevMessenger(() => {}), () => new Date(), { maxActivePerCustomer: 1, log: console.warn });
  const salon = await salonById(db, DEMO.salon.id);
  const S = DEMO.services;
  const walkIns: [string, string[], string | null][] = [
    ['Arjun', [S.mensCut, S.beardTrim], DEMO.stylists.rahul],
    ['Priya', [S.womensCut], null],
    ['Kabir', [S.kidsCut], null],
    ['Neha', [S.rootTouchUp], DEMO.stylists.farah],
  ];
  const ids: string[] = [];
  for (const [name, services, stylist] of walkIns) {
    const { result } = await queue.join({
      salon, serviceIds: services, stylistId: stylist, source: 'walk_in', customerId: null, guestName: name, actor: 'system',
    });
    ids.push(result);
  }
  const actor = { salon, staffUserId: DEMO.staff.owner.id, role: 'owner' as const, stylistId: null };
  await queue.entryAction(actor, ids[0]!, 'start');
  console.log(`Added ${ids.length} demo walk-ins (first one in service)`);
}

const staff = Object.values(DEMO.staff).map((s) => s.email).join(', ');
console.log(`Staff logins: ${staff} / password: ${process.env.SEED_STAFF_PASSWORD ? '(SEED_STAFF_PASSWORD)' : DEMO.defaultPassword}`);
console.log(`Customer app: /s/${DEMO.salon.slug}   Dashboard: /dashboard/${DEMO.salon.slug}`);
await db.end();
