import type { Request, Response } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

const paginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const localizedSchema = z.object({ en: z.string(), ar: z.string() });

const carSchema = z.object({
  plate: z.string().min(1),
  colour: localizedSchema,
  colourHex: z.string().min(1),
  bodyType: z.enum(['sedan', 'suv', 'pickup', 'coupe']),
});

export const placeOrderSchema = z
  .object({
    lines: z.array(z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1) })),
    promoCode: z.string().optional(),
    fulfillment: z.enum(['delivery', 'curbside']),
    addressId: z.string().optional(),
    priceToken: z.string().min(1),
    paymentKind: z.enum(['card', 'credit', 'cash']),
    car: carSchema.optional(),
  })
  // Curbside staff cannot work without a car to match in the bay — captured
  // at order creation, never asked for after the fact (see BACKEND-DESIGN §9).
  .superRefine((data, ctx) => {
    if (data.fulfillment === 'curbside' && !data.car) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['car'],
        message: 'Car details are required for curbside pickup orders.',
      });
    }
  });

export const arrivalSchema = z.object({ arrival: z.enum(['on_way', 'near']) });

export const cancelSchema = z.object({ reason: z.string().min(1) });

export const linesUpdateSchema = z.object({
  lines: z.array(z.object({ variantId: z.string().min(1), fulfilledQty: z.number().int().min(0) })),
});

export const statusUpdateSchema = z.object({
  status: z.enum([
    'placed',
    'packed',
    'out_for_delivery',
    'delivered',
    'ready_for_pickup',
    'customer_arrived',
    'handed_over',
  ]),
});

// -------------------------------------------------------------- customer

export async function place(req: Request, res: Response): Promise<void> {
  if (!req.ctx.tenantId || !req.ctx.userId) throw AppError.unauthenticated();
  const key = req.header('Idempotency-Key')!; // presence enforced by the `idempotent` middleware
  const order = await service.placeOrder(req.ctx.tenantId, req.ctx.userId, req.body, key);
  res.status(201).json(order.toJSON());
}

export async function list(req: Request, res: Response): Promise<void> {
  const q = paginationQuery.parse(req.query);
  res.json(await service.listCustomerOrders(req.ctx.tenantId!, req.ctx.userId!, q));
}

export async function get(req: Request, res: Response): Promise<void> {
  res.json(await service.getOrder(req.ctx.tenantId!, req.params.id!, req.ctx.userId!));
}

export async function receipt(req: Request, res: Response): Promise<void> {
  res.json(await service.getReceipt(req.ctx.tenantId!, req.params.id!, req.ctx.userId!));
}

export async function arrived(req: Request, res: Response): Promise<void> {
  res.json(await service.markArrived(req.ctx.tenantId!, req.params.id!, req.ctx.userId!));
}

export async function updateArrival(req: Request, res: Response): Promise<void> {
  res.json(await service.setArrival(req.ctx.tenantId!, req.params.id!, req.ctx.userId!, req.body.arrival));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const order = await service.cancelOrder(
    req.ctx.tenantId!,
    req.params.id!,
    { userId: req.ctx.userId!, role: req.ctx.role! },
    req.body.reason,
  );
  res.json(order);
}

// ----------------------------------------------------------------- admin

export async function adminList(req: Request, res: Response): Promise<void> {
  const q = paginationQuery.extend({
    status: z.string().optional(),
    fulfillment: z.string().optional(),
    q: z.string().optional(),
  }).parse(req.query);
  res.json(await service.listAdminOrders(req.ctx.tenantId!, q));
}

export async function adminGet(req: Request, res: Response): Promise<void> {
  res.json(await service.getOrder(req.ctx.tenantId!, req.params.id!));
}

export async function adminUpdateStatus(req: Request, res: Response): Promise<void> {
  const order = await service.transitionStatus(req.ctx.tenantId!, req.params.id!, req.body.status, {
    userId: req.ctx.userId!,
    role: req.ctx.role!,
  });
  await writeAudit(req, 'order.status', 'orders', req.params.id!, {
    status: { before: null, after: req.body.status },
  });
  res.json(order);
}

export async function adminUpdateLines(req: Request, res: Response): Promise<void> {
  const order = await service.updateOrderLines(req.ctx.tenantId!, req.params.id!, req.body.lines, {
    userId: req.ctx.userId!,
  });
  await writeAudit(req, 'order.lines', 'orders', req.params.id!);
  res.json(order);
}

export async function adminCancel(req: Request, res: Response): Promise<void> {
  const order = await service.cancelOrder(
    req.ctx.tenantId!,
    req.params.id!,
    { userId: req.ctx.userId!, role: req.ctx.role!, grade: req.ctx.grade },
    req.body.reason,
  );
  await writeAudit(req, 'order.cancel', 'orders', req.params.id!);
  res.json(order);
}

export const verifyCodeSchema = z.object({ code: z.string().length(4) });
export const assignRiderSchema = z.object({ riderId: z.string().min(1) });

export async function adminVerifyCode(req: Request, res: Response): Promise<void> {
  const order = await service.verifyCode(req.ctx.tenantId!, req.params.id!, req.body.code);
  res.json(order);
}

export async function adminAssignRider(req: Request, res: Response): Promise<void> {
  const order = await service.manualAssignRider(req.ctx.tenantId!, req.params.id!, req.body.riderId);
  await writeAudit(req, 'order.rider', 'orders', req.params.id!, {
    riderId: { before: null, after: req.body.riderId },
  });
  res.json(order);
}

export async function adminRefund(req: Request, res: Response): Promise<void> {
  // §9.7 — refunds are recorded, not executed; there is no gateway in v1 (D12).
  await writeAudit(req, 'order.refund', 'orders', req.params.id!, {
    note: { before: null, after: req.body.reason ?? '' },
  });
  const order = await service.getOrder(req.ctx.tenantId!, req.params.id!);
  res.json(order);
}
