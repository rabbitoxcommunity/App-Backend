import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { rateLimit, byPhone, byIp } from '../../middleware/rateLimit.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const authRouter = Router();

// §22 — 1 per 30s per phone, 5 per hour per phone, 20 per hour per IP.
authRouter.post(
  '/otp',
  validate({ body: controller.otpRequestSchema }),
  rateLimit({ windowSeconds: 30, max: 1, keyFn: byPhone }),
  rateLimit({ windowSeconds: 3600, max: 5, keyFn: byPhone }),
  rateLimit({ windowSeconds: 3600, max: 20, keyFn: byIp }),
  asyncHandler(controller.requestOtp),
);

authRouter.post('/verify', validate({ body: controller.otpVerifySchema }), asyncHandler(controller.verifyOtp));

authRouter.post('/refresh', validate({ body: controller.refreshSchema }), asyncHandler(controller.refresh));

authRouter.post('/logout', validate({ body: controller.refreshSchema }), asyncHandler(controller.logout));

authRouter.post(
  '/staff/login',
  validate({ body: controller.staffLoginSchema }),
  rateLimit({ windowSeconds: 900, max: 10, keyFn: (r) => `staff:${r.body.email}` }),
  asyncHandler(controller.staffLogin),
);

// Delivery staff use the phone + password their store admin set on the Admin
// staff screen. Keyed per phone rather than per email — a rider has no email.
authRouter.post(
  '/delivery/login',
  validate({ body: controller.deliveryLoginSchema }),
  rateLimit({ windowSeconds: 900, max: 10, keyFn: byPhone }),
  asyncHandler(controller.deliveryLogin),
);

authRouter.post(
  '/platform/login',
  validate({ body: controller.platformLoginSchema }),
  rateLimit({ windowSeconds: 900, max: 10, keyFn: (r) => `platform:${r.body.email}` }),
  asyncHandler(controller.platformLogin),
);
