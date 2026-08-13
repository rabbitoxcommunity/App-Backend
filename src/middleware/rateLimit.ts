import type { NextFunction, Request, Response } from 'express';
import { getRedis } from '../config/redis.js';
import { AppError } from '../lib/errors.js';

/**
 * §22 RATE LIMITING. Fixed-window counter in Redis, keyed per the caller's
 * `keyFn`. §22 keys per-tenant resources by tenant and per-IP limits
 * globally — `keyFn` decides which, per call site.
 */
export function rateLimit(opts: {
  windowSeconds: number;
  max: number;
  keyFn: (req: Request) => string;
}) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const redis = getRedis();
      const key = `ratelimit:${opts.keyFn(req)}:${Math.floor(Date.now() / 1000 / opts.windowSeconds)}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, opts.windowSeconds);
      }
      if (count > opts.max) {
        throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', {
          retryAfterSeconds: opts.windowSeconds,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const byIp = (req: Request): string => req.ip ?? 'unknown';
export const byPhone = (req: Request): string => (req.body?.phone as string) ?? byIp(req);
export const byUser = (req: Request): string => String(req.ctx?.userId ?? byIp(req));
