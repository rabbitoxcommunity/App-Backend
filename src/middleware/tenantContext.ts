import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { runWithContext, type RequestContext } from '../context/requestContext.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { AppError } from '../lib/errors.js';
import { ulid } from 'ulid';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
    }
  }
}

/**
 * §1.2 HOW A TENANT IS RESOLVED. Runs on every request, before any route
 * handler and before requireRole. Populates AsyncLocalStorage (§1.3) so the
 * tenantScope Mongoose plugin can see it for the rest of the request.
 */
export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || ulid();
  res.setHeader('X-Request-Id', requestId);

  let ctx: RequestContext = {
    tenantId: null,
    userId: null,
    role: null,
    grade: null,
    requestId,
    impersonatedBy: null,
  };

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const claims = verifyAccessToken(authHeader.slice(7));
      ctx = {
        ...ctx,
        userId: new Types.ObjectId(claims.sub),
        role: claims.role,
        grade: claims.grade ?? null,
        tenantId: claims.tenantId ? new Types.ObjectId(claims.tenantId) : null,
        impersonatedBy: claims.imp ? new Types.ObjectId(claims.imp) : null,
      };
    } catch {
      return next(AppError.unauthenticated('The access token is invalid or expired.'));
    }
  }

  // Rule 2 (§1.2): unauthenticated/public requests resolve tenant from the
  // header every client build sends.
  if (!ctx.tenantId && ctx.role !== 'superAdmin') {
    const headerTenant = req.headers['x-tenant-id'] as string | undefined;
    if (headerTenant) {
      if (!Types.ObjectId.isValid(headerTenant)) {
        return next(new AppError('TENANT_MISMATCH', 'X-Tenant-Id is not a valid id.'));
      }
      ctx.tenantId = new Types.ObjectId(headerTenant);
    }
  } else if (ctx.tenantId && req.headers['x-tenant-id']) {
    // RULE: token and header disagreeing is a hard reject, never header-wins.
    if (String(ctx.tenantId) !== req.headers['x-tenant-id']) {
      return next(new AppError('TENANT_MISMATCH', 'Token tenant and X-Tenant-Id header disagree.'));
    }
  }

  // Rule 3 (§1.2): superAdmin may act cross-tenant via an explicit query param.
  if (ctx.role === 'superAdmin' && !ctx.tenantId) {
    const qTenant = req.query.tenantId as string | undefined;
    if (qTenant && Types.ObjectId.isValid(qTenant)) {
      ctx.tenantId = new Types.ObjectId(qTenant);
    }
  }

  req.ctx = ctx;
  runWithContext(ctx, next);
}
