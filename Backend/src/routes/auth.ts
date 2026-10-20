import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { requireCustomer, requireStaffUser } from '../auth/guards.js';
import { verifyPassword } from '../auth/password.js';
import { notFound, unauthorized } from '../errors.js';
import { parse } from '../http.js';

const customerView = (c: { id: string; phone: string; name: string | null }) => ({
  id: c.id,
  phone: c.phone,
  name: c.name,
  needs_name: !c.name,
});

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  const otpLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post('/v1/auth/otp/request', { config: otpLimit }, async (req) => {
    const body = parse(z.object({ phone: z.string().min(1).max(30) }), req.body);
    return deps.otp.request(body.phone, req.ip);
  });

  app.post('/v1/auth/otp/verify', { config: otpLimit }, async (req) => {
    const body = parse(z.object({ phone: z.string().min(1).max(30), code: z.string() }), req.body);
    const { customer, isNew } = await deps.otp.verify(body.phone, body.code.trim());
    const token = app.jwt.sign({ sub: customer.id, typ: 'customer' }, { expiresIn: deps.config.CUSTOMER_TOKEN_TTL });
    return { token, is_new: isNew, customer: customerView(customer) };
  });

  app.get('/v1/me', async (req) => {
    const id = await requireCustomer(req);
    const { rows } = await deps.db.query(`SELECT id, phone, name FROM customers WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound('Customer');
    return { customer: customerView(rows[0]) };
  });

  app.patch('/v1/me', async (req) => {
    const id = await requireCustomer(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    const { rows } = await deps.db.query(
      `UPDATE customers SET name = $2, updated_at = $3 WHERE id = $1 RETURNING id, phone, name`,
      [id, body.name, deps.now()],
    );
    if (!rows[0]) throw notFound('Customer');
    return { customer: customerView(rows[0]) };
  });

  app.post('/v1/staff/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
    const { rows } = await deps.db.query<{ id: string; password_hash: string; is_active: boolean }>(
      `SELECT id, password_hash, is_active FROM staff_users WHERE email = $1`,
      [body.email.toLowerCase()],
    );
    const u = rows[0];
    // Same error for unknown email and wrong password.
    if (!u || !u.is_active || !(await verifyPassword(body.password, u.password_hash))) {
      throw unauthorized('Email or password is incorrect');
    }
    const token = app.jwt.sign({ sub: u.id, typ: 'staff' }, { expiresIn: deps.config.STAFF_TOKEN_TTL });
    return { token, ...(await staffProfile(deps, u.id)) };
  });

  app.get('/v1/staff/me', async (req) => {
    const id = await requireStaffUser(req);
    return staffProfile(deps, id);
  });
}

async function staffProfile(deps: Deps, staffUserId: string) {
  const { rows: users } = await deps.db.query(`SELECT id, email, name FROM staff_users WHERE id = $1 AND is_active`, [staffUserId]);
  if (!users[0]) throw unauthorized();
  const { rows: memberships } = await deps.db.query(
    `SELECT s.id AS salon_id, s.slug AS salon_slug, s.name AS salon_name, m.role, st.id AS stylist_id
       FROM staff_members m JOIN salons s ON s.id = m.salon_id
       LEFT JOIN stylists st ON st.staff_member_id = m.id
      WHERE m.staff_user_id = $1 ORDER BY s.name`,
    [staffUserId],
  );
  return { staff: users[0], memberships };
}
