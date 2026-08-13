/**
 * §21 SEEDING. Seeds one demo tenant with a coherent fixture set modelled
 * on the app's own mock data (categories, products, promo, pickup store,
 * car colours, a credit account). Runs every §21 assertion at the end and
 * throws loudly if any fails — this is also, incidentally, the cheapest
 * end-to-end smoke test of the pricing engine and order pipeline in the
 * whole project, since orders are placed through the real service
 * functions rather than inserted directly.
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { disconnectRedis } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { runWithContext } from '../context/requestContext.js';
import { onboardTenant } from '../modules/tenants/service.js';
import { Category } from '../models/Category.js';
import { Product } from '../models/Product.js';
import { PromoCode } from '../models/PromoCode.js';
import { Tenant } from '../models/Tenant.js';
import { User } from '../models/User.js';
import { Address } from '../models/Address.js';
import { CreditAccount } from '../models/CreditAccount.js';
import { CreditEntry } from '../models/CreditEntry.js';
import { Order } from '../models/Order.js';
import { Banner } from '../models/Banner.js';
import { priceBasket } from '../modules/cart/service.js';
import { placeOrder } from '../modules/orders/service.js';
import { appendLedgerEntry } from '../modules/credit/service.js';
import { toFils } from '../lib/money.js';
import { isValidIcon } from '../lib/iconCatalog.js';
import { buildSearchTokens } from '../lib/searchTokens.js';

const single = (price: number, barcode: string, stock: 'available' | 'low' | 'out' = 'available', lowStockCount: number | null = null) => [
  { optionIds: {}, price: toFils(price), barcode, stock, lowStockCount },
];

async function seed(): Promise<void> {
  await connectDb();
  logger.info('Seeding FreshCart demo tenant...');

  // Fresh start for repeatable seeding.
  const existing = await Tenant.findOne({ slug: 'freshcart-demo' });
  if (existing) {
    logger.warn('Demo tenant already exists — dropping it before reseeding.');
    const tid = existing._id;
    await Promise.all([
      Category.deleteMany({ tenantId: tid }),
      Product.deleteMany({ tenantId: tid }),
      PromoCode.deleteMany({ tenantId: tid }),
      User.deleteMany({ tenantId: tid }),
      Address.deleteMany({ tenantId: tid }),
      CreditAccount.deleteMany({ tenantId: tid }),
      CreditEntry.deleteMany({ tenantId: tid }),
      Order.deleteMany({ tenantId: tid }),
      Banner.deleteMany({ tenantId: tid }),
    ]);
    await Tenant.findByIdAndDelete(tid);
  }

  const { tenantId } = await onboardTenant({
    slug: 'freshcart-demo',
    name: { en: 'FreshCart', ar: 'فريش كارت' },
    ownerName: 'Store Owner',
    ownerEmail: 'owner@freshcart-demo.test',
    ownerPhone: '+971501112233',
    ownerPassword: 'ChangeMe123!',
    storeName: { en: 'FreshCart Jumeirah 1', ar: 'فريش كارت جميرا 1' },
  });
  const tid = new Types.ObjectId(tenantId);

  await Tenant.findByIdAndUpdate(tid, {
    status: 'active',
    'settings.carColours': [
      { hex: '#FFFFFF', name: { en: 'White', ar: 'أبيض' } },
      { hex: '#14181C', name: { en: 'Black', ar: 'أسود' } },
      { hex: '#9AA1A6', name: { en: 'Silver', ar: 'فضي' } },
      { hex: '#5A6169', name: { en: 'Grey', ar: 'رمادي' } },
      { hex: '#C0392B', name: { en: 'Red', ar: 'أحمر' } },
      { hex: '#2C5AA0', name: { en: 'Blue', ar: 'أزرق' } },
      { hex: '#F2C10D', name: { en: 'Yellow', ar: 'أصفر' } },
      { hex: '#E2711D', name: { en: 'Orange', ar: 'برتقالي' } },
      { hex: '#1E7A3C', name: { en: 'Green', ar: 'أخضر' } },
      { hex: '#6B4A2F', name: { en: 'Brown', ar: 'بني' } },
      { hex: '#C9A227', name: { en: 'Gold', ar: 'ذهبي' } },
    ],
    'store.bays': 5,
    'store.baysFree': 5,
  });

  await runWithContext(
    { tenantId: tid, userId: null, role: 'superAdmin', grade: null, requestId: 'seed', impersonatedBy: null },
    async () => {
      // ---------------------------------------------------------- categories
      const beverages = await Category.create({
        tenantId: tid,
        slug: 'beverages',
        name: { en: 'Beverages', ar: 'مشروبات' },
        icon: 'p-water',
        status: 'published',
        subcategories: [{ slug: 'water', name: { en: 'Water', ar: 'مياه' } }, { slug: 'juice', name: { en: 'Juice', ar: 'عصير' } }],
      });
      const dairy = await Category.create({
        tenantId: tid,
        slug: 'dairy-eggs',
        name: { en: 'Dairy & Eggs', ar: 'حليب وبيض' },
        icon: 'cat-dairy',
        status: 'published',
        subcategories: [{ slug: 'milk', name: { en: 'Milk & laban', ar: 'حليب ولبن' } }],
      });
      const pantry = await Category.create({
        tenantId: tid,
        slug: 'pantry',
        name: { en: 'Pantry', ar: 'مواد غذائية' },
        icon: 'cat-household',
        status: 'published',
      });
      const bakery = await Category.create({
        tenantId: tid,
        slug: 'bakery',
        name: { en: 'Bakery', ar: 'مخبوزات' },
        icon: 'cat-bakery',
        status: 'published',
      });
      const fruitsVeg = await Category.create({
        tenantId: tid,
        slug: 'fruits-veg',
        name: { en: 'Fruits & Veg', ar: 'فواكه وخضار' },
        icon: 'cat-fruits',
        status: 'published',
      });

      for (const icon of ['p-water', 'p-juice', 'p-energy', 'p-tea', 'p-cola', 'p-milk', 'p-banana', 'p-eggs', 'p-bread']) {
        if (!isValidIcon(icon)) throw new Error(`Seed uses an icon not in the catalog: ${icon}`);
      }

      // ------------------------------------------------------------ products
      const productDefs = [
        { name: 'Mineral Water 1.5L', icon: 'p-water', category: beverages, price: 9.75, barcode: '6291000200011' },
        { name: 'Orange Juice 1L', icon: 'p-juice', category: beverages, price: 14.5, barcode: '6291000200028', stock: 'low' as const, low: 3 },
        { name: 'Iced Tea 500ml', icon: 'p-tea', category: beverages, price: 12.0, barcode: '6291000200035', stock: 'out' as const },
        { name: 'Cola 330ml', icon: 'p-cola', category: beverages, price: 13.25, barcode: '6291000200042' },
        { name: 'Fresh Laban 1L', icon: 'p-milk', category: dairy, price: 7.5, barcode: '6291000200059' },
        { name: 'Apple Juice 1L', icon: 'p-juice', category: beverages, price: 12.0, barcode: '6291000200066' },
        { name: 'Bananas 1kg', icon: 'p-banana', category: fruitsVeg, price: 6.5, barcode: '6291000300017' },
        { name: 'Fresh Milk 2L', icon: 'p-milk', category: dairy, price: 11.0, barcode: '6291000400014' },
        { name: 'Eggs 30pc', icon: 'p-eggs', category: dairy, price: 17.25, barcode: '6291000400021' },
        { name: 'Arabic Bread', icon: 'p-bread', category: bakery, price: 4.25, barcode: '6291000500011' },
        { name: 'Basmati Rice 5kg', icon: 'p-bread', category: pantry, price: 48.0, barcode: '8901030765432' },
      ];

      const products = [];
      for (const def of productDefs) {
        const product = await Product.create({
          tenantId: tid,
          categoryId: def.category._id,
          name: { en: def.name, ar: def.name },
          subtitle: { en: '', ar: '' },
          icon: def.icon,
          variants: single(def.price, def.barcode, def.stock ?? 'available', def.low ?? null),
          status: 'published',
          popularity: Math.floor(Math.random() * 100),
          searchTokens: buildSearchTokens([def.name]),
        });
        product.defaultVariantId = product.variants[0]!._id;
        await product.save();
        products.push(product);
      }

      // -------------------------------------------------------------- promo
      await PromoCode.create({
        tenantId: tid,
        code: 'FRESH10',
        discountType: 'percent',
        value: 10,
        active: true,
      });

      // ------------------------------------------------------------ banners
      await Banner.create({
        tenantId: tid,
        imageUrl: 'https://placehold.co/1200x400?text=FreshCart',
        linkType: 'none',
        active: true,
        sortOrder: 0,
      });

      // ----------------------------------------------------------- customer
      const customer = await User.create({
        tenantId: tid,
        role: 'customer',
        name: 'Aisha',
        phone: '+971502148873',
        creditApproved: true,
      });

      await Address.create({
        tenantId: tid,
        customerId: customer._id,
        label: { en: 'Home', ar: 'المنزل' },
        lines: { en: 'Villa 22, Al Wasl, Dubai', ar: 'فيلا 22، الوصل، دبي' },
        phone: '+971502148873',
        isPrimary: true,
      });

      // §13.2 credit account, seeded via the real ledger-append path so the
      // running balance is provably correct by construction — see the
      // assertion at the end for the check that matters.
      await CreditAccount.create({
        tenantId: tid,
        customerId: customer._id,
        limit: toFils(1000),
        dueDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        approvedAt: new Date(),
      });

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await appendLedgerEntry(
            {
              tenantId: tid,
              customerId: customer._id,
              kind: 'charge',
              title: { en: 'Order #FC-2790', ar: 'الطلب FC-2790' },
              subtitle: { en: '12 items', ar: '12 منتجًا' },
              amount: toFils(84.75),
            },
            session,
          );
          await appendLedgerEntry(
            {
              tenantId: tid,
              customerId: customer._id,
              kind: 'charge',
              title: { en: 'Order #FC-2744', ar: 'الطلب FC-2744' },
              subtitle: { en: '9 items', ar: '9 منتجات' },
              amount: toFils(79.75),
            },
            session,
          );
          await appendLedgerEntry(
            {
              tenantId: tid,
              customerId: customer._id,
              kind: 'payment',
              title: { en: 'Payment received', ar: 'تم استلام دفعة' },
              subtitle: { en: 'Card •••• 4218', ar: 'بطاقة •••• 4218' },
              amount: -toFils(200),
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      // ------------------------------------------------------- a real order
      // Placed through the actual pricing + order pipeline, not inserted
      // directly — proves the whole engine works end to end.
      const address = await Address.findOne({ tenantId: tid, customerId: customer._id });
      const priced = await priceBasket(tid, String(customer._id), {
        lines: [
          { variantId: String(products[0]!.variants[0]!._id), quantity: 2 },
          { variantId: String(products[4]!.variants[0]!._id), quantity: 1 },
        ],
        fulfillment: 'delivery',
        addressId: String(address!._id),
      });

      const order = await placeOrder(
        tid,
        customer._id,
        {
          lines: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
          fulfillment: 'delivery',
          addressId: String(address!._id),
          priceToken: priced.priceToken,
          paymentKind: 'cash',
        },
        `seed-${Date.now()}`,
      );

      logger.info({ reference: order.reference, total: order.total }, 'Seeded a real order');

      // ========================================================= §21 ASSERTIONS
      await runAssertions(tid);
    },
  );

  logger.info('Seed complete.');
  await disconnectDb();
  await disconnectRedis();
  // Placing an order touches modules/orders/rider.ts, which imports the
  // BullMQ queues in jobs/queues.ts — constructing those opens persistent
  // Redis connections as a side effect of the import, independent of
  // disconnectRedis() above (that only closes the app's own getRedis()
  // client). A one-shot script doesn't need to unwind BullMQ's internals
  // gracefully; exit explicitly rather than leaving the process hanging.
  process.exit(0);
}

async function runAssertions(tenantId: Types.ObjectId): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`SEED ASSERTION FAILED: ${msg}`);
  };

  // 1. every order: sum(line.unitPrice * quantity) == subtotal (before discounts)
  // 2. every order: subtotal - discount + deliveryFee == total
  const orders = await Order.find({ tenantId });
  for (const order of orders) {
    const lineSum = order.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    if (lineSum !== order.subtotal) fail(`order ${order.reference}: line sum ${lineSum} != subtotal ${order.subtotal}`);
    const expectedTotal = order.subtotal - order.discount + order.deliveryFee;
    if (expectedTotal !== order.total) fail(`order ${order.reference}: expected total ${expectedTotal} != ${order.total}`);
  }

  // 3. credit: balance == sum(entries.amount), and the newest entry's balanceAfter == balance
  const accounts = await CreditAccount.find({ tenantId });
  for (const account of accounts) {
    const entries = await CreditEntry.find({ tenantId, accountId: account._id }).sort({ at: 1 });
    const sum = entries.reduce((s, e) => s + e.amount, 0);
    if (sum !== account.balance) fail(`credit account ${account._id}: entry sum ${sum} != balance ${account.balance}`);
    const newest = entries[entries.length - 1];
    if (newest && newest.balanceAfter !== account.balance) {
      fail(`credit account ${account._id}: newest entry balanceAfter ${newest.balanceAfter} != balance ${account.balance}`);
    }
  }

  // 4. every Localized field on a published document has non-empty en AND ar
  const products = await Product.find({ tenantId, status: 'published' });
  for (const p of products) {
    if (!p.name.en || !p.name.ar) fail(`product ${p._id}: published with incomplete name Localized`);
  }
  const categories = await Category.find({ tenantId, status: 'published' });
  for (const c of categories) {
    if (!c.name.en || !c.name.ar) fail(`category ${c._id}: published with incomplete name Localized`);
  }

  // 5. every `icon` value exists in the shared icon list
  for (const p of products) {
    if (!isValidIcon(p.icon)) fail(`product ${p._id}: icon "${p.icon}" not in icon catalog`);
  }
  for (const c of categories) {
    if (!isValidIcon(c.icon)) fail(`category ${c._id}: icon "${c.icon}" not in icon catalog`);
  }

  // 6. no document lacks a tenantId
  const collections = [Category, Product, Order, CreditAccount, CreditEntry, Address, User];
  for (const Model of collections) {
    // @ts-expect-error - runtime check across heterogeneous models, not meant to be statically typed
    const orphan = await Model.findOne({ tenantId: { $exists: false } }).setOptions({ skipTenantScope: true });
    if (orphan) fail(`${Model.modelName} ${orphan._id}: missing tenantId`);
  }

  logger.info('All §21 seed assertions passed.');
}

seed().catch((err) => {
  logger.error({ err }, 'Seed failed');
  process.exit(1);
});
