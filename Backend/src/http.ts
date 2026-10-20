import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest('VALIDATION_ERROR', 'Some fields are missing or invalid', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const slugParam = z.object({ slug: z.string().min(1).max(80) });
export const entryParams = z.object({ slug: z.string().min(1).max(80), entryId: uuid });
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
