import { hashPassword } from './auth/password.js';
import { type Db, withTx } from './db.js';

/**
 * Demo data for one pilot salon. IDs are fixed so the frontend can hard-code
 * fixtures and links (e.g. /s/demo-salon-bandra). Running the seed again
 * wipes and recreates this salon only.
 */
export const DEMO = {
  salon: { id: '00000000-0000-4000-8000-000000000001', slug: 'demo-salon-bandra' },
  services: {
    mensCut: '00000000-0000-4000-8000-000000000101',
    womensCut: '00000000-0000-4000-8000-000000000102',
    beardTrim: '00000000-0000-4000-8000-000000000103',
    washBlowDry: '00000000-0000-4000-8000-000000000104',
    globalColour: '00000000-0000-4000-8000-000000000105',
    rootTouchUp: '00000000-0000-4000-8000-000000000106',
    headMassage: '00000000-0000-4000-8000-000000000107',
    kidsCut: '00000000-0000-4000-8000-000000000108',
  },
  stylists: {
    anjali: '00000000-0000-4000-8000-000000000201',
    rahul: '00000000-0000-4000-8000-000000000202',
    farah: '00000000-0000-4000-8000-000000000203',
    vikram: '00000000-0000-4000-8000-000000000204',
  },
  staff: {
    owner: { id: '00000000-0000-4000-8000-000000000301', email: 'owner@demo-salon.test', name: 'Meera (Owner)' },
    receptionist: { id: '00000000-0000-4000-8000-000000000302', email: 'desk@demo-salon.test', name: 'Sunita (Front desk)' },
    stylist: { id: '00000000-0000-4000-8000-000000000303', email: 'anjali@demo-salon.test', name: 'Anjali' },
  },
  defaultPassword: 'salon-demo-1234',
} as const;

const S = DEMO.services;
const T = DEMO.stylists;

const SERVICES: [string, string, string | null, number, number][] = [
  // id, name, description, price (₹), default minutes
  [S.mensCut, "Men's haircut", 'Cut and style', 300, 30],
  [S.womensCut, "Women's haircut", 'Cut, wash and style', 600, 45],
  [S.beardTrim, 'Beard trim', 'Shape and line-up', 150, 15],
  [S.washBlowDry, 'Hair wash & blow-dry', null, 400, 30],
  [S.globalColour, 'Global hair colour', 'Full head colour, includes processing time', 2500, 90],
  [S.rootTouchUp, 'Root touch-up', null, 1200, 60],
  [S.headMassage, 'Head massage', 'Oil head massage', 350, 20],
  [S.kidsCut, 'Kids haircut (under 10)', null, 250, 20],
];

// stylist, display name, status, sort, staff key, [service, custom minutes | null][]
const STYLISTS: [string, string, string, number, keyof typeof DEMO.staff | null, [string, number | null][]][] = [
  [T.anjali, 'Anjali', 'available', 1, 'stylist', [
    [S.womensCut, null], [S.washBlowDry, null], [S.globalColour, 80], [S.rootTouchUp, 50], [S.mensCut, 35],
  ]],
  [T.rahul, 'Rahul', 'available', 2, null, [
    [S.mensCut, 25], [S.beardTrim, null], [S.headMassage, null], [S.kidsCut, null],
  ]],
  [T.farah, 'Farah', 'available', 3, null, [
    [S.womensCut, 50], [S.washBlowDry, null], [S.globalColour, null], [S.rootTouchUp, null], [S.kidsCut, 25],
  ]],
  [T.vikram, 'Vikram', 'off', 4, null, [
    [S.mensCut, null], [S.beardTrim, 10], [S.headMassage, null], [S.kidsCut, null],
  ]],
];

export async function seedDemo(db: Db, opts: { password?: string; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const password = await hashPassword(opts.password ?? DEMO.defaultPassword);
  await withTx(db, async (tx) => {
    await tx.query(`DELETE FROM queue_events WHERE salon_id = $1`, [DEMO.salon.id]);
    await tx.query(`DELETE FROM queue_entries WHERE salon_id = $1`, [DEMO.salon.id]);
    await tx.query(`DELETE FROM salons WHERE id = $1`, [DEMO.salon.id]);

    await tx.query(
      `INSERT INTO salons (id, slug, name, address, phone, lat, lng, timezone, buffer_minutes, noshow_grace_minutes,
                           turn_alert_minutes, join_radius_m)
       VALUES ($1, $2, 'Demo Salon, Bandra', 'Hill Road, Bandra West, Mumbai 400050', '+912226400000',
               19.0544, 72.8340, 'Asia/Kolkata', 5, 5, 10, 3000)`,
      [DEMO.salon.id, DEMO.salon.slug],
    );
    // Open 10:00-21:00 every day.
    for (let d = 0; d < 7; d++) {
      await tx.query(`INSERT INTO business_hours (salon_id, weekday, opens, closes) VALUES ($1, $2, '10:00', '21:00')`, [DEMO.salon.id, d]);
    }
    for (const [i, [id, name, desc, rupees, minutes]] of SERVICES.entries()) {
      await tx.query(
        `INSERT INTO services (id, salon_id, name, description, price_paise, default_minutes, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, DEMO.salon.id, name, desc ?? null, rupees * 100, minutes, i + 1],
      );
    }

    const memberIds: Record<string, string> = {};
    for (const [key, u] of Object.entries(DEMO.staff)) {
      await tx.query(
        `INSERT INTO staff_users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, is_active = true`,
        [u.id, u.email, u.name, password],
      );
      const role = key === 'owner' ? 'owner' : key === 'receptionist' ? 'receptionist' : 'stylist';
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO staff_members (staff_user_id, salon_id, role) VALUES ($1, $2, $3) RETURNING id`,
        [u.id, DEMO.salon.id, role],
      );
      memberIds[key] = rows[0]!.id;
    }

    for (const [id, name, status, sort, staffKey, offers] of STYLISTS) {
      await tx.query(
        `INSERT INTO stylists (id, salon_id, staff_member_id, display_name, status, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, DEMO.salon.id, staffKey ? memberIds[staffKey] : null, name, status, sort],
      );
      for (const [serviceId, custom] of offers) {
        await tx.query(
          `INSERT INTO stylist_services (salon_id, stylist_id, service_id, custom_minutes) VALUES ($1, $2, $3, $4)`,
          [DEMO.salon.id, id, serviceId, custom],
        );
      }
    }
  });
  log(`Seeded ${DEMO.salon.slug}: ${SERVICES.length} services, ${STYLISTS.length} stylists, ${Object.keys(DEMO.staff).length} staff logins`);
}
