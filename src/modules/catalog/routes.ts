import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import * as controller from './controller.js';

export const catalogRouter = Router();

catalogRouter.get('/categories', asyncHandler(controller.listCategories));
catalogRouter.get('/categories/:idOrSlug/products', asyncHandler(controller.getCategoryProducts));
catalogRouter.get('/products', asyncHandler(controller.listProducts));
catalogRouter.get('/products/:id', asyncHandler(controller.getProduct));
catalogRouter.get('/search', asyncHandler(controller.search));
