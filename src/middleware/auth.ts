import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';

type Role = 'superAdmin' | 'storeAdmin' | 'deliveryStaff' | 'customer';
type Grade = 'owner' | 'manager' | 'staff';

const GRADE_RANK: Record<Grade, number> = { staff: 0, manager: 1, owner: 2 };

/**
 * §5.2 PERMISSION MATRIX. For storeAdmin routes, `minGrade` is the MINIMUM
 * grade required — 'manager' also admits 'owner'. Grades are irrelevant for
 * the other three roles.
 */
export function requireRole(role: Role, minGrade?: Grade) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.ctx;
    if (!ctx?.userId || !ctx.role) {
      return next(AppError.unauthenticated());
    }
    if (ctx.role !== role) {
      return next(AppError.forbidden(`This route requires the "${role}" role.`));
    }
    if (role === 'storeAdmin' && minGrade) {
      const have = ctx.grade ? GRADE_RANK[ctx.grade] : -1;
      if (have < GRADE_RANK[minGrade]) {
        return next(AppError.forbidden(`This route requires at least "${minGrade}" grade.`));
      }
    }
    if ((role === 'storeAdmin' || role === 'deliveryStaff' || role === 'customer') && !ctx.tenantId) {
      return next(AppError.unauthenticated('Token is missing a tenant.'));
    }
    next();
  };
}

/** Any authenticated user, any role — used for /me and similar. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.ctx?.userId) return next(AppError.unauthenticated());
  next();
}
