import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import * as ordersService from '../orders/service.js';
import { signPrivateUpload } from '../../lib/s3.js';

// Delivery staff only ever handle `delivery` orders — curbside has no rider.
// The only rider-initiated transition here is packed -> out_for_delivery;
// `delivered`/`handed_over` go through confirm() with the confirmation code.
export const statusSchema = z.object({ status: z.literal('out_for_delivery') });

export const confirmSchema = z.object({
  code: z.string().length(4),
  photoUrl: z.string().min(1),
  geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
  amountCollected: z.number().int().optional(),
});

export const availabilitySchema = z.object({ availability: z.enum(['available', 'off_shift']) });

export async function myOrders(req: Request, res: Response): Promise<void> {
  res.json(await service.myOrders(req.ctx.tenantId!, req.ctx.userId!));
}

export async function accept(req: Request, res: Response): Promise<void> {
  const order = await ordersService.acceptRiderOffer(req.ctx.tenantId!, req.params.id!, req.ctx.userId!);
  res.json(order);
}

export async function updateStatus(req: Request, res: Response): Promise<void> {
  const order = await ordersService.transitionStatus(req.ctx.tenantId!, req.params.id!, req.body.status, {
    userId: req.ctx.userId!,
    role: req.ctx.role!,
  });
  res.json(order);
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const order = await ordersService.confirmDelivery(req.ctx.tenantId!, req.params.id!, req.body, {
    userId: req.ctx.userId!,
  });
  res.json(order);
}

export async function signProofUpload(req: Request, res: Response): Promise<void> {
  const result = await signPrivateUpload(String(req.ctx.tenantId), req.body.contentType);
  res.json(result);
}

export async function setAvailability(req: Request, res: Response): Promise<void> {
  const rider = await service.setAvailability(req.ctx.tenantId!, req.ctx.userId!, req.body.availability);
  res.json(rider);
}

export async function summary(req: Request, res: Response): Promise<void> {
  res.json(await service.mySummary(req.ctx.tenantId!, req.ctx.userId!));
}
