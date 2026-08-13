import { Router } from 'express';

/**
 * §10 THE ROUTE TABLE. Mounted at API_BASE_PATH (/api/v1) after
 * tenantContext has run. Each module owns its own router; this file is only
 * composition. Filled in as each build phase lands — see BACKEND-DESIGN.txt
 * §24 for the phase order this follows.
 */
export const apiRouter = Router();

// Phase 1 — identity
import { authRouter } from '../modules/auth/routes.js';
import { meRouter } from '../modules/auth/me.routes.js';
import { tenantPublicRouter } from '../modules/tenants/public.routes.js';
apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/', tenantPublicRouter);

// Phase 2 — catalog
import { catalogRouter } from '../modules/catalog/routes.js';
import { adminCatalogRouter } from '../modules/catalog/admin.routes.js';
import { importRouter } from '../modules/import/routes.js';
import { uploadsRouter } from '../modules/uploads/routes.js';
apiRouter.use('/', catalogRouter);
apiRouter.use('/admin', adminCatalogRouter);
apiRouter.use('/admin/import', importRouter);
apiRouter.use('/admin/uploads', uploadsRouter);

// Phase 3 — cart, promos, orders
import { cartRouter } from '../modules/cart/routes.js';
import { promoPublicRouter } from '../modules/promos/routes.js';
import { adminPromosRouter } from '../modules/promos/admin.routes.js';
import { ordersRouter } from '../modules/orders/routes.js';
import { adminOrdersRouter } from '../modules/orders/admin.routes.js';
apiRouter.use('/cart', cartRouter);
apiRouter.use('/', promoPublicRouter);
apiRouter.use('/admin/promos', adminPromosRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/admin/orders', adminOrdersRouter);

// Phase 4 — customers, addresses, credit
import { addressesRouter } from '../modules/addresses/routes.js';
import { creditRouter } from '../modules/credit/routes.js';
import { adminCustomersRouter } from '../modules/customers/admin.routes.js';
import { adminCreditRouter } from '../modules/credit/admin.routes.js';
apiRouter.use('/addresses', addressesRouter);
apiRouter.use('/credit', creditRouter);
apiRouter.use('/admin/customers', adminCustomersRouter);
apiRouter.use('/admin/credit', adminCreditRouter);

// Admin gap fill — staff accounts and payment method management (Admin dashboard integration)
import { adminStaffRouter } from '../modules/staff/admin.routes.js';
import { adminPaymentMethodsRouter } from '../modules/paymentMethods/admin.routes.js';
apiRouter.use('/admin/staff', adminStaffRouter);
apiRouter.use('/admin/payment-methods', adminPaymentMethodsRouter);

// Phase 5 — delivery staff + curbside
import { deliveryRouter } from '../modules/delivery/routes.js';
import { adminCurbsideRouter } from '../modules/curbside/admin.routes.js';
apiRouter.use('/delivery', deliveryRouter);
apiRouter.use('/admin/curbside', adminCurbsideRouter);

// Phase 6 — merchandising, content, notifications
import { merchandisingPublicRouter } from '../modules/merchandising/routes.js';
import { adminMerchandisingRouter } from '../modules/merchandising/admin.routes.js';
import { contentRouter } from '../modules/content/routes.js';
import { adminContentRouter } from '../modules/content/admin.routes.js';
import { notificationsRouter } from '../modules/notifications/routes.js';
apiRouter.use('/', merchandisingPublicRouter);
apiRouter.use('/admin', adminMerchandisingRouter);
apiRouter.use('/', contentRouter);
apiRouter.use('/admin', adminContentRouter);
apiRouter.use('/', notificationsRouter);

// Phase 7 — analytics + platform
import { adminAnalyticsRouter } from '../modules/analytics/admin.routes.js';
import { adminConfigRouter } from '../modules/tenants/admin.routes.js';
import { platformRouter } from '../modules/platform/routes.js';
apiRouter.use('/admin/analytics', adminAnalyticsRouter);
apiRouter.use('/admin', adminConfigRouter);
apiRouter.use('/platform', platformRouter);
