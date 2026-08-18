import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import * as ordersService from '../orders/service.js';
import { signPrivateUpload } from '../../lib/s3.js';

// Delivery staff only ever handle `delivery` orders — curbside has no rider.
//
// A rider may walk an order forward through the two steps that happen while
// it is physically in their hands: picking it up off the shelf
// (placed -> packed) and leaving the shop with it (packed ->
// out_for_delivery). Requiring counter staff to mark an order packed in the
// dashboard first left riders stuck looking at an order they were already
// holding, with no button to press.
//
// `delivered` is deliberately NOT in this list. It is only reachable through
// confirm(), which demands the customer's confirmation code — a rider must
// never be able to close an order out by tapping a status button alone.
// canTransition() still enforces the ordering, so this cannot skip a step.
export const statusSchema = z.object({
  status: z.enum(['packed', 'out_for_delivery']),
});

// `photoUrl` is optional: proof-of-delivery photos are a nice-to-have that
// must never be the reason a rider is stuck on a doorstep with no signal or
// a dead camera. The confirmation code is the actual proof.
// `amountCollected` is in fils, like every money field on the API.
export const confirmSchema = z.object({
  code: z.string().length(4),
  photoUrl: z.string().min(1).optional(),
  geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
  amountCollected: z.number().int().nonnegative().optional(),
});

export const availabilitySchema = z.object({ availability: z.enum(['available', 'off_shift']) });

export async function myOrders(req: Request, res: Response): Promise<void> {
  res.json(await service.myOrders(req.ctx.tenantId!, req.ctx.userId!));
}

export async function accept(req: Request, res: Response): Promise<void> {
  const order = await ordersService.acceptRiderOffer(req.ctx.tenantId!, req.params.id!, req.ctx.userId!);
  res.json(order);
}

/** Open pool — this rider takes an unclaimed order. Races are resolved server-side. */
export async function claim(req: Request, res: Response): Promise<void> {
  const order = await ordersService.claimOrder(req.ctx.tenantId!, req.params.id!, req.ctx.userId!);
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
