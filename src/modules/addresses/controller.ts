import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';

const localizedSchema = z.object({ en: z.string(), ar: z.string() });

export const addressBodySchema = z.object({
  label: localizedSchema,
  lines: localizedSchema,
  phone: z.string().nullable().optional(),
  geo: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await service.listAddresses(req.ctx.tenantId!, req.ctx.userId!));
}

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await service.createAddress(req.ctx.tenantId!, req.ctx.userId!, req.body));
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json(await service.updateAddress(req.ctx.tenantId!, req.ctx.userId!, req.params.id!, req.body));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.deleteAddress(req.ctx.tenantId!, req.ctx.userId!, req.params.id!);
  res.status(204).send();
}
