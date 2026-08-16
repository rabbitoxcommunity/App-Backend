import { Router } from 'express';
import { z } from 'zod';
import { User } from '../../models/User.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';

export const meRouter = Router();

meRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.ctx.userId);
    if (!user) throw AppError.notFound('User');
    res.json(user.toJSON());
  }),
);

const patchMeSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  language: z.enum(['en', 'ar']).optional(),
});

meRouter.patch(
  '/',
  requireAuth,
  validate({ body: patchMeSchema }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.ctx.userId);
    if (!user) throw AppError.notFound('User');
    Object.assign(user, req.body);
    await user.save();
    res.json(user.toJSON());
  }),
);

const pushTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
});

meRouter.post(
  '/push-token',
  requireAuth,
  validate({ body: pushTokenSchema }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.ctx.userId);
    if (!user) throw AppError.notFound('User');
    const withoutToken = user.pushTokens.filter((t) => t.token !== req.body.token);
    user.pushTokens.splice(0, user.pushTokens.length, ...withoutToken);
    user.pushTokens.push({ token: req.body.token, platform: req.body.platform, updatedAt: new Date() });
    await user.save();
    res.status(204).send();
  }),
);
