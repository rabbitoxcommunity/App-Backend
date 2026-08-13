import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { AppError } from '../../lib/errors.js';
import { ImportBatch } from '../../models/ImportBatch.js';

export const registerBatchSchema = z.object({
  fileUrl: z.string().url(),
  originalName: z.string().min(1),
});

export const mappingSchema = z.object({
  nameEn: z.string(),
  nameAr: z.string(),
  category: z.string(),
  price: z.string(),
  barcode: z.string().optional(),
  productKey: z.string().optional(),
  variantAttribute: z.string().optional(),
  icon: z.string().optional(),
  imageUrl: z.string().optional(),
});

export async function uploadBatch(req: Request, res: Response): Promise<void> {
  if (!req.ctx.tenantId || !req.ctx.userId) throw AppError.unauthenticated();
  const batch = await service.createBatch(
    String(req.ctx.tenantId),
    String(req.ctx.userId),
    req.body.fileUrl,
    req.body.originalName,
  );
  res.status(201).json(batch);
}

export async function getBatch(req: Request, res: Response): Promise<void> {
  const batch = await ImportBatch.findById(req.params.id);
  if (!batch) throw AppError.notFound('Import batch');
  res.json(batch);
}

export async function saveMapping(req: Request, res: Response): Promise<void> {
  const batch = await service.saveMapping(req.params.id!, String(req.ctx.tenantId), req.body);
  res.json(batch);
}

export async function validate(req: Request, res: Response): Promise<void> {
  const result = await service.validateBatch(req.params.id!, String(req.ctx.tenantId));
  res.json(result);
}

export async function commit(req: Request, res: Response): Promise<void> {
  const batch = await service.commitBatch(req.params.id!, String(req.ctx.tenantId));
  res.status(202).json(batch);
}
