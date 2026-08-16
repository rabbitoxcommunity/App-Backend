import type { Request } from 'express';
import { AuditLog } from '../models/AuditLog.js';

/**
 * §4.24 — call after a write commits. `changes` is a changed-fields diff:
 * { field: { before, after } }, not a full document snapshot.
 */
export async function writeAudit(
  req: Request,
  action: string,
  collectionName: string,
  documentId: string | null,
  changes: Record<string, { before: unknown; after: unknown }> = {},
): Promise<void> {
  if (!req.ctx.tenantId) return; // platform-level actions audit separately (§19)
  await AuditLog.create({
    tenantId: req.ctx.tenantId,
    actorId: req.ctx.userId,
    // §10 impersonation — attribute both identities when acting through impersonate().
    actorRole: req.ctx.impersonatedBy ? `storeAdmin (impersonated by superAdmin ${req.ctx.impersonatedBy})` : req.ctx.role ?? '',
    action,
    collectionName,
    documentId,
    changes,
    ip: req.ip,
  });
}

/**
 * §19 platform-level audit — `writeAudit` above deliberately no-ops when
 * `req.ctx.tenantId` is null (every superAdmin request), so suspend/
 * reactivate/configure/onboard/reset-owner-access need their own path. Each
 * of those actions IS about one specific tenant, so the row still carries
 * that tenantId even though the actor (a PlatformUser) isn't a member of it.
 */
export async function writePlatformAudit(
  req: Request,
  tenantId: string,
  action: string,
  documentId: string | null,
  changes: Record<string, { before: unknown; after: unknown }> = {},
): Promise<void> {
  await AuditLog.create({
    tenantId,
    actorId: req.ctx.userId,
    actorRole: 'superAdmin',
    action,
    collectionName: 'tenants',
    documentId,
    changes,
    ip: req.ip,
  });
}

export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed[key] = { before: before[key], after: after[key] };
    }
  }
  return changed;
}
