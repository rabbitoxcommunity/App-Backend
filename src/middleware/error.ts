import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../config/logger.js';

/** §11 ERRORS — one envelope shape everywhere. Must be the LAST middleware. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = req.ctx?.requestId ?? (res.getHeader('X-Request-Id') as string) ?? 'unknown';

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, requestId, code: err.code }, 'AppError (5xx)');
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request body failed validation.',
        details: { issues: err.issues },
        requestId,
      },
    });
    return;
  }

  // A unique-index violation (e.g. {tenantId, email}, {tenantId, phone}) is a
  // MongoDB-level constraint, not something Mongoose's own validators catch —
  // left untranslated it bubbles up as an opaque 500. Every unique index in
  // this app pairs the real field with tenantId, so the offending field is
  // whichever key in keyPattern isn't tenantId.
  const asDriverError = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (asDriverError.code === 11000) {
    const field = Object.keys(asDriverError.keyPattern ?? {}).find((k) => k !== 'tenantId');
    const label = field === 'email' ? 'email address' : field === 'phone' ? 'phone number' : field ? field : 'value';
    const conflict = AppError.conflict(`This ${label} is already in use.`, field ? { field } : {});
    res.status(conflict.status).json({
      error: { code: conflict.code, message: conflict.message, details: conflict.details, requestId },
    });
    return;
  }

  logger.error({ err, requestId }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Something went wrong.', details: {}, requestId },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      details: {},
      requestId: req.ctx?.requestId ?? 'unknown',
    },
  });
}
