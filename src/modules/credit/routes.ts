import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const creditRouter = Router();

creditRouter.use(requireRole('customer'));

creditRouter.get('/', asyncHandler(controller.getMyAccount));
creditRouter.get('/entries', asyncHandler(controller.getMyEntries));
