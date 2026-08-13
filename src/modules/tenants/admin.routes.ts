import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { writeAudit } from '../../lib/audit.js';
import * as service from './service.js';
import { AuditLog } from '../../models/AuditLog.js';
import { decodeCursor, encodeCursor, cursorFilter } from '../../lib/cursorPagination.js';

export const adminConfigRouter = Router();

const configUpdateSchema = z.object({
  name: z.object({ en: z.string(), ar: z.string() }).optional(),
  branding: z
    .object({ logoUrl: z.string().nullable().optional(), primaryHex: z.string().optional(), appIconUrl: z.string().nullable().optional() })
    .optional(),
  locale: z.object({ defaultLanguage: z.enum(['en', 'ar']).optional(), timezone: z.string().optional() }).optional(),
  store: z.record(z.unknown()).optional(),
  settings: z.record(z.unknown()).optional(),
});

adminConfigRouter.get(
  '/config',
  requireRole('storeAdmin', 'owner'),
  asyncHandler(async (req, res) => res.json(await service.getConfig(req.ctx.tenantId!))),
);

adminConfigRouter.put(
  '/config',
  requireRole('storeAdmin', 'owner'),
  validate({ body: configUpdateSchema }),
  asyncHandler(async (req, res) => {
    const tenant = await service.updateConfig(req.ctx.tenantId!, req.body);
    await writeAudit(req, 'tenant.config', 'tenants', String(req.ctx.tenantId), {
      fields: { before: null, after: Object.keys(req.body) },
    });
    res.json(tenant);
  }),
);

// §10 GET /admin/audit — cursor paginated, owner only (§5.2).
adminConfigRouter.get(
  '/audit',
  requireRole('storeAdmin', 'owner'),
  asyncHandler(async (req, res) => {
    const q = z.object({ cursor: z.string().optional(), limit: z.coerce.number().min(1).max(100).default(20) }).parse(
      req.query,
    );
    const cursor = decodeCursor(q.cursor);
    const filter = { tenantId: req.ctx.tenantId, ...cursorFilter('at', cursor) };
    const items = await AuditLog.find(filter)
      .sort({ at: -1, _id: -1 })
      .limit(q.limit + 1);
    const hasMore = items.length > q.limit;
    const page = items.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({
      items: page,
      nextCursor: hasMore && last ? encodeCursor(last.at.getTime(), String(last._id)) : null,
    });
  }),
);
