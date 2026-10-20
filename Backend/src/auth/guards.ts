import type { FastifyRequest } from 'fastify';
import type { Queryable } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';
import { type SalonRow, salonBySlug } from '../salons/repo.js';

export type Role = 'owner' | 'receptionist' | 'stylist';

export interface TokenPayload {
  sub: string;
  typ: 'customer' | 'staff';
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}

async function verify(req: FastifyRequest, typ: TokenPayload['typ']): Promise<string> {
  try {
    await req.jwtVerify();
  } catch {
    throw unauthorized();
  }
  if (req.user.typ !== typ) throw unauthorized(typ === 'staff' ? 'Staff sign-in required' : 'Customer sign-in required');
  return req.user.sub;
}

export const requireCustomer = (req: FastifyRequest) => verify(req, 'customer');
export const requireStaffUser = (req: FastifyRequest) => verify(req, 'staff');

export interface StaffAccess {
  salon: SalonRow;
  staffUserId: string;
  memberId: string;
  role: Role;
  /** The stylist record linked to this staff member, if any. */
  stylistId: string | null;
}

/**
 * Every dashboard route goes through here: resolves the salon from the URL,
 * checks the caller is a member of *that* salon, and checks their role.
 */
export async function requireStaff(req: FastifyRequest, db: Queryable, slug: string, roles: Role[]): Promise<StaffAccess> {
  const staffUserId = await requireStaffUser(req);
  const salon = await salonBySlug(db, slug, { includeInactive: true });
  const { rows } = await db.query<{ id: string; role: Role; stylist_id: string | null; is_active: boolean }>(
    `SELECT m.id, m.role, st.id AS stylist_id, u.is_active
       FROM staff_members m
       JOIN staff_users u ON u.id = m.staff_user_id
       LEFT JOIN stylists st ON st.staff_member_id = m.id
      WHERE m.staff_user_id = $1 AND m.salon_id = $2`,
    [staffUserId, salon.id],
  );
  const m = rows[0];
  if (!m || !m.is_active) throw forbidden('You are not a member of this salon');
  if (!roles.includes(m.role)) throw forbidden(`This action needs one of: ${roles.join(', ')}`);
  return { salon, staffUserId, memberId: m.id, role: m.role, stylistId: m.stylist_id };
}

export const ALL_ROLES: Role[] = ['owner', 'receptionist', 'stylist'];
export const DESK_ROLES: Role[] = ['owner', 'receptionist'];
export const OWNER: Role[] = ['owner'];
