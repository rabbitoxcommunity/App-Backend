import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import * as service from './service.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { realtime } from '../../realtime/io.js';

const paginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// `limit: null` is an explicit grant of UNLIMITED credit, not a missing
// value — hence .nullable() rather than .optional(), so it has to be sent
// deliberately and can never be produced by forgetting the field.
export const approveCreditSchema = z.object({ limit: z.number().int().min(0).nullable() });
export const paymentSchema = z.object({ amount: z.number().int().positive() });

// ------------------------------------------------------------- customer

export async function getMyAccount(req: Request, res: Response): Promise<void> {
  res.json(await service.getAccount(req.ctx.tenantId!, req.ctx.userId!));
}

export async function getMyEntries(req: Request, res: Response): Promise<void> {
  const q = paginationQuery.parse(req.query);
  res.json(await service.listEntries(req.ctx.tenantId!, req.ctx.userId!, q));
}

// ---------------------------------------------------------------- admin

export async function approve(req: Request, res: Response): Promise<void> {
  const account = await service.approveCredit(
    req.ctx.tenantId!,
    req.params.id!,
    req.body.limit,
    req.ctx.userId!,
  );
  await writeAudit(req, 'credit.approve', 'creditAccounts', String(account._id), {
    limit: { before: null, after: req.body.limit },
  });
  realtime.creditChanged(String(req.ctx.tenantId), req.params.id!, account);
  res.json(account);
}

export async function adminEntries(req: Request, res: Response): Promise<void> {
  const q = paginationQuery.parse(req.query);
  res.json(await service.adminListEntries(req.ctx.tenantId!, req.params.customerId!, q));
}

export async function recordPayment(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();
  let entry: Awaited<ReturnType<typeof service.recordPayment>> | undefined;
  try {
    await session.withTransaction(async () => {
      entry = await service.recordPayment(
        req.ctx.tenantId!,
        req.params.customerId!,
        req.body.amount,
        req.ctx.userId!,
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  if (!entry) throw new AppError('INTERNAL', 'Payment was not recorded.');
  await writeAudit(req, 'credit.payment', 'creditEntries', String(entry._id), {
    amount: { before: null, after: req.body.amount },
  });
  // §14 — emit only after the transaction has committed, mirroring the
  // account state that's now actually in MongoDB.
  const account = await service.getAccount(
    req.ctx.tenantId!,
    new mongoose.Types.ObjectId(req.params.customerId!),
  );
  realtime.creditChanged(String(req.ctx.tenantId), req.params.customerId!, account);
  res.status(201).json(entry);
}

/** One customer's account, so the Admin edit dialog can prefill the current limit. */
export async function adminGetAccount(req: Request, res: Response): Promise<void> {
  res.json(
    await service.getAccount(req.ctx.tenantId!, new mongoose.Types.ObjectId(req.params.customerId!)),
  );
}

export async function revoke(req: Request, res: Response): Promise<void> {
  res.json(await service.revokeCredit(req.ctx.tenantId!, req.params.id!));
}

export async function exposure(req: Request, res: Response): Promise<void> {
  res.json(await service.creditExposure(req.ctx.tenantId!));
}
