import type { NextFunction, Request, Response } from 'express';
import { getRedis } from '../config/redis.js';
import { AppError } from '../lib/errors.js';
import { IdempotencyKey } from '../models/IdempotencyKey.js';

const LOCK_TTL_SECONDS = 30;

/**
 * §13.7 IDEMPOTENCY. Applied to POST /orders, POST /admin/credit/:id/payment
 * and POST /delivery/orders/:id/confirm. Without it a double-tap or a
 * network retry creates two of whatever the route creates.
 *
 * `routeName` scopes the key so the same Idempotency-Key value on two
 * different routes never collides. On a first call the handler runs
 * normally and its JSON response is captured and stored; a repeat with the
 * same key replays the stored response verbatim without touching the
 * handler.
 */
export function idempotent(routeName: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.header('Idempotency-Key');
    if (!key) {
      next(new AppError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required on this route.'));
      return;
    }
    if (!req.ctx.tenantId) {
      next(AppError.unauthenticated());
      return;
    }

    try {
      const existing = await IdempotencyKey.findOne({ tenantId: req.ctx.tenantId, route: routeName, key });
      if (existing) {
        // §13.7 — "a repeat with the same key returns the ORIGINAL order,
        // 200 not 201": the replay is always 200, even though the original
        // creating request was 201. Only the body — the actual resource —
        // needs to match; the status code communicates "here is what
        // already exists", not "something was just created".
        res.status(200).json(existing.body);
        return;
      }

      const redis = getRedis();
      const lockKey = `idempotency:${req.ctx.tenantId}:${routeName}:${key}`;
      const acquired = await redis.set(lockKey, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
      if (!acquired) {
        next(
          new AppError('REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is already being processed.'),
        );
        return;
      }

      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode < 400) {
          IdempotencyKey.create({
            tenantId: req.ctx.tenantId,
            route: routeName,
            key,
            status: res.statusCode,
            body,
          }).catch(() => undefined); // best-effort; the Redis lock already prevented the concurrent race
        }
        return originalJson(body);
      }) as Response['json'];

      next();
    } catch (err) {
      next(err);
    }
  };
}
