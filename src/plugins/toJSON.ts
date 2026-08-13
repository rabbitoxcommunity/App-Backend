import type { Schema } from 'mongoose';

/**
 * Fields that must never reach a client even if a service accidentally
 * `.select('+field')`s them for internal verification (e.g. staffLogin
 * needs the hash in-memory to call argon2.verify, but the response must
 * not carry it). `select: false` on the schema already stops the DEFAULT
 * query from fetching these; this is the second layer for the moment
 * something explicitly opts back in and forgets to strip it before
 * returning — belt and suspenders, not a substitute for `select: false`.
 */
const ALWAYS_STRIP = ['passwordHash', 'mfaSecret', 'codeHash', 'tokenHash'];

/**
 * §2 CONVENTIONS — documents expose `id` (string), never `_id`, `__v` or
 * `tenantId`. Clients cannot influence tenantId anyway; no reason to leak it.
 */
export function toJSONPlugin(schema: Schema): void {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      if (ret._id) {
        ret.id = String(ret._id);
        delete ret._id;
      }
      delete ret.__v;
      delete ret.tenantId;
      for (const field of ALWAYS_STRIP) delete ret[field];
      return ret;
    },
  });
}
