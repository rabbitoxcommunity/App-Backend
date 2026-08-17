import * as XLSX from 'xlsx';
import { Types } from 'mongoose';
import { ImportBatch } from '../../models/ImportBatch.js';
import { Product } from '../../models/Product.js';
import { Category } from '../../models/Category.js';
import { AppError } from '../../lib/errors.js';
import { fuzzyMatch } from '../../lib/fuzzy.js';
import { guessCategoryIcon, isValidIcon } from '../../lib/iconCatalog.js';
import { buildSearchTokens } from '../../lib/searchTokens.js';
import { importQueue } from '../../jobs/queues.js';
import { logger } from '../../config/logger.js';
import { AuditLog } from '../../models/AuditLog.js';
import { assertProductLimit } from '../../lib/planLimits.js';

const PREVIEW_ROWS = 20;

async function fetchWorkbook(fileUrl: string): Promise<XLSX.WorkBook> {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new AppError('VALIDATION_FAILED', `Could not fetch the uploaded file (${response.status}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  // codepage 65001 = UTF-8. Without it SheetJS decodes CSV bytes with a
  // legacy single-byte codepage, so Arabic arrives as mojibake
  // ("أرز" -> "Ø£Ø±Ø²"). That is not cosmetic here: a product needs a real
  // Arabic name to be publishable at all (§4 Localized rule), so every
  // imported row was effectively unpublishable. XLSX files carry their own
  // encoding and are unaffected, but passing this is harmless for them.
  //
  // raw:true keeps cells as text instead of coercing them. A CSV has no cell
  // types, so SheetJS reads a zero-padded barcode as a NUMBER and silently
  // drops the padding — "000001346923" became 1346923, which breaks till
  // scanning and collapses two distinct SKUs into one. XLSX files carry
  // explicit string cells and read identically either way (verified against a
  // 4,853-row sheet: same values, prices still parse).
  return XLSX.read(buffer, { type: 'buffer', codepage: 65001, raw: true });
}

function sheetToRows(workbook: XLSX.WorkBook): Record<string, unknown>[] {
  const sheet = workbook.Sheets[workbook.SheetNames[0]!];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

// §17 STEP 1/2 — upload + parse. Reads headers and the first 20 rows back
// for the admin to map columns against.
export async function createBatch(tenantId: string, uploadedBy: string, fileUrl: string, originalName: string) {
  const workbook = await fetchWorkbook(fileUrl);
  const rows = sheetToRows(workbook);
  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];

  return ImportBatch.create({
    tenantId,
    uploadedBy,
    fileUrl,
    originalName,
    status: 'uploaded',
    headers,
    previewRows: rows.slice(0, PREVIEW_ROWS),
    stats: { rows: rows.length, created: 0, updated: 0, skipped: 0, errored: 0 },
  });
}

export type ColumnMap = {
  nameEn: string;
  nameAr: string;
  category: string;
  price: string;
  barcode?: string;
  productKey?: string; // rows sharing this collapse into one product's variants
  variantAttribute?: string; // e.g. "flavour" or "size" column -> becomes the axis
  icon?: string;
  imageUrl?: string;
};

/**
 * §17 STEP 3 — the map is saved on the tenant's most recent batch and
 * offered as the default next time; the same shop uploads the same
 * spreadsheet shape every week. We persist it per-batch here; the admin
 * route layer is responsible for prefilling from the last batch.
 */
export async function saveMapping(batchId: string, tenantId: string, columnMap: ColumnMap) {
  const batch = await ImportBatch.findOne({ _id: batchId, tenantId });
  if (!batch) throw AppError.notFound('Import batch');
  batch.columnMap = columnMap;
  batch.status = 'mapping';
  await batch.save();
  return batch;
}

type ValidatedRow = {
  raw: Record<string, unknown>;
  rowNumber: number;
  productKey: string;
  nameEn: string;
  nameAr: string;
  categoryText: string;
  price: number;
  barcode: string | null;
  variantAttrValue: string | null;
  icon: string | null;
  imageUrl: string | null;
};

async function validateRows(
  rows: Record<string, unknown>[],
  map: ColumnMap,
  tenantId: string,
): Promise<{ valid: ValidatedRow[]; errors: Array<{ row: number; column: string; code: string; message: string }> }> {
  const errors: Array<{ row: number; column: string; code: string; message: string }> = [];
  const valid: ValidatedRow[] = [];

  rows.forEach((raw, idx) => {
    const rowNumber = idx + 2; // header is row 1
    const nameEn = String(raw[map.nameEn] ?? '').trim();
    const priceRaw = raw[map.price];
    const price = Number(priceRaw);

    if (!nameEn) {
      errors.push({ row: rowNumber, column: map.nameEn, code: 'MISSING_NAME', message: 'Name (en) is required.' });
      return;
    }
    if (!priceRaw || Number.isNaN(price) || price < 0) {
      errors.push({ row: rowNumber, column: map.price, code: 'BAD_PRICE', message: 'Price is missing or invalid.' });
      return;
    }

    const icon = map.icon ? String(raw[map.icon] ?? '').trim() : null;
    if (icon && !isValidIcon(icon)) {
      // Not a hard failure (§17 RULES) — falls back to a category default at commit time.
    }

    valid.push({
      raw,
      rowNumber,
      productKey: map.productKey ? String(raw[map.productKey] ?? nameEn).trim() : nameEn,
      nameEn,
      nameAr: String(raw[map.nameAr] ?? '').trim(),
      categoryText: String(raw[map.category] ?? '').trim(),
      price: Math.round(price * 100), // sheet is in AED, we store fils (§7)
      barcode: map.barcode ? String(raw[map.barcode] ?? '').trim() || null : null,
      variantAttrValue: map.variantAttribute ? String(raw[map.variantAttribute] ?? '').trim() || null : null,
      icon: icon && isValidIcon(icon) ? icon : null,
      imageUrl: map.imageUrl ? String(raw[map.imageUrl] ?? '').trim() || null : null,
    });
  });

  return { valid, errors };
}

// §17 STEP 4 — dry run. Nothing is written.
export async function validateBatch(batchId: string, tenantId: string) {
  const batch = await ImportBatch.findOne({ _id: batchId, tenantId });
  if (!batch) throw AppError.notFound('Import batch');
  if (!batch.columnMap || Object.keys(batch.columnMap as object).length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Save a column mapping before validating.');
  }

  batch.status = 'validating';
  await batch.save();

  const workbook = await fetchWorkbook(batch.fileUrl);
  const rows = sheetToRows(workbook);
  const { valid, errors } = await validateRows(rows, batch.columnMap as ColumnMap, tenantId);

  batch.stats = {
    rows: rows.length,
    created: 0,
    updated: 0,
    skipped: errors.length,
    errored: errors.length,
  };
  batch.rowErrors.splice(0, batch.rowErrors.length, ...errors);
  batch.status = errors.length === rows.length && rows.length > 0 ? 'failed' : 'ready';
  await batch.save();

  return { batch, validRowCount: valid.length };
}

// §17 STEP 5 — background commit. Enqueued; modules/import/worker.ts does the writing.
export async function commitBatch(batchId: string, tenantId: string) {
  const batch = await ImportBatch.findOne({ _id: batchId, tenantId });
  if (!batch) throw AppError.notFound('Import batch');
  if (batch.status !== 'ready') {
    throw new AppError('VALIDATION_FAILED', `Batch is "${batch.status}", not "ready". Validate it first.`);
  }

  batch.status = 'importing';
  await batch.save();

  await importQueue.add('commit', { tenantId, batchId });
  return batch;
}

const slugifyCategory = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'category';

/**
 * The actual write, run by the BullMQ worker (registered in
 * modules/import/worker.ts). Exported separately so it can also be unit
 * tested without touching the queue.
 *
 * CATEGORY CLEANUP (§17): fuzzy-match against existing category names in
 * both languages, and CREATE the category when nothing matches. The original
 * rule was "import never invents categories", with unmatched rows landing
 * uncategorised in the needs-fixing queue — but that queue is per-product
 * with no bulk edit, so a 4,853-row sheet carrying 97 category names put
 * every single product in it and the catalogue was unusable. Inventing a
 * category the owner can rename is strictly better than inventing nothing.
 *
 * VARIANT GROUPING (§17): rows sharing productKey collapse into one product;
 * variantAttribute becomes the single axis.
 *
 * MATCHING for update-vs-create (§17): barcode first, then name — but see the
 * comment at the lookup, the name fallback is NOT a catch-all.
 */
export async function runCommit(tenantId: string, batchId: string): Promise<void> {
  const batch = await ImportBatch.findOne({ _id: batchId, tenantId });
  if (!batch) return;

  try {
    const workbook = await fetchWorkbook(batch.fileUrl);
    const rows = sheetToRows(workbook);
    const { valid, errors } = await validateRows(rows, batch.columnMap as ColumnMap, tenantId);

    const categories = await Category.find({ archivedAt: null });
    let categoriesCreated = 0;
    let nextSortOrder = categories.reduce((max, c) => Math.max(max, c.sortOrder ?? 0), 0) + 1;

    /**
     * Newly created categories are pushed back into `categories` so later rows
     * fuzzy-match them instead of creating a near-duplicate — that is what
     * collapses "CHOCOLATE" and "CHOCOLATES" into one aisle for free.
     *
     * Created published + visible, unlike the products themselves (which stay
     * draft per §17). A draft category is invisible to customers, so publishing
     * the products later would leave them unreachable by browsing — the exact
     * silent failure this whole change exists to prevent. An empty aisle until
     * its products are published is the milder of the two.
     */
    const resolveCategoryId = async (text: string): Promise<Types.ObjectId | null> => {
      if (!text) return null;

      const match = categories.find(
        (c) => fuzzyMatch(c.name.en, text) || fuzzyMatch(c.name.ar, text),
      );
      if (match) return match._id;

      const base = slugifyCategory(text);
      let slug = base;
      for (let n = 2; await Category.exists({ slug }); n += 1) slug = `${base}-${n}`;

      const created = await Category.create({
        tenantId,
        slug,
        name: { en: text, ar: text },
        icon: guessCategoryIcon(text),
        sortOrder: nextSortOrder++,
        visible: true,
        status: 'published',
      });
      categories.push(created);
      categoriesCreated += 1;
      return created._id;
    };

    const grouped = new Map<string, ValidatedRow[]>();
    for (const row of valid) {
      const key = row.productKey;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    // §19.2 / §17 RULE — fail the whole batch early rather than partially
    // import past the plan's product cap. Worst case every group is new.
    await assertProductLimit(new Types.ObjectId(tenantId), grouped.size);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const [, groupRows] of grouped) {
      const first = groupRows[0]!;

      const categoryId = await resolveCategoryId(first.categoryText);

      const variants = groupRows.map((r) => ({
        optionIds: {},
        price: r.price,
        barcode: r.barcode,
        stock: 'available' as const,
      }));

      /**
       * Barcode is the only identity we trust. The name fallback applies ONLY
       * when the group carries no barcode at all.
       *
       * It used to run whenever the barcode lookup missed, which quietly
       * corrupted data: a sheet listing the same item twice under two codes
       * ("000001346923" and "1346923", same Description) matched the second
       * group to the first product by name and overwrote its variants — so the
       * first barcode vanished and the till could no longer scan it. A barcode
       * that matches nothing means a NEW product, not a rename.
       */
      const barcodes = groupRows.map((r) => r.barcode).filter(Boolean) as string[];
      const existing =
        barcodes.length > 0
          ? await Product.findOne({ 'variants.barcode': { $in: barcodes } })
          : await Product.findOne({ 'name.en': first.nameEn });

      const searchTokens = buildSearchTokens([
        first.nameEn,
        first.nameAr,
        ...groupRows.map((r) => r.barcode ?? '').filter(Boolean),
      ]);

      if (existing) {
        // Merge, never replace. `existing.variants = variants` discarded every
        // variant the product already had, so re-importing a weekly price sheet
        // silently dropped any size/flavour not present in that week's file —
        // along with its barcode and stock state. Match on barcode; a
        // barcode-less incoming row updates the barcode-less variant if there
        // is one, rather than piling up duplicates on every import.
        for (const incoming of variants) {
          const target = incoming.barcode
            ? existing.variants.find((v) => v.barcode === incoming.barcode)
            : existing.variants.find((v) => !v.barcode);
          if (target) {
            target.price = incoming.price;
            target.stock = incoming.stock;
          } else {
            existing.variants.push(incoming as never);
          }
        }
        existing.categoryId = categoryId ?? existing.categoryId;
        existing.searchTokens = searchTokens;
        existing.importBatchId = batch._id;
        await existing.save();
        updated += 1;
      } else {
        await Product.create({
          tenantId,
          categoryId,
          name: { en: first.nameEn, ar: first.nameAr },
          subtitle: { en: '', ar: '' },
          icon: first.icon ?? 'cat-household',
          variants,
          searchTokens,
          // §17 RULE: import writes DRAFTS. Nothing reaches customers until published.
          status: 'draft',
          importBatchId: batch._id,
        });
        created += 1;
      }
    }

    skipped = errors.length;

    batch.stats = { rows: rows.length, created, updated, skipped, errored: errors.length };
    batch.status = 'done';
    await batch.save();

    logger.info(
      { batchId, tenantId, created, updated, skipped, categoriesCreated },
      'Import commit finished',
    );

    // §17 RULE — one audit row per import, with the batch stats, not one per product.
    await AuditLog.create({
      tenantId,
      actorId: batch.uploadedBy,
      actorRole: 'storeAdmin',
      action: 'import.commit',
      // `collectionName`, not `collection` — the latter shadows Mongoose's
      // reserved Document property and is NOT the schema field, so this write
      // failed the required-field check. It threw after the products had
      // already been created, and the catch below then marked the whole batch
      // "failed" even though the import had fully succeeded.
      collectionName: 'importBatches',
      documentId: batch._id,
      changes: {
        stats: { before: null, after: batch.stats },
        // Import can now create categories, which is a catalogue-shape change
        // the owner did not make by hand — it belongs in the audit trail.
        categoriesCreated: { before: 0, after: categoriesCreated },
      },
    });
  } catch (err) {
    logger.error({ err, batchId }, 'Import commit failed');
    batch.status = 'failed';
    await batch.save();
  }
}
