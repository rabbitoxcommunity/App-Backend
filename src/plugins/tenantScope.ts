import type { Schema, Query, Document, Aggregate } from 'mongoose';
import { getContext, requireTenantId } from '../context/requestContext.js';

/**
 * §1.3 of the design doc — the single most important file in this project.
 *
 * Every tenant-scoped schema calls `schema.plugin(tenantScopePlugin)`. From
 * then on:
 *   - every find/update/delete/count/distinct query is filtered by the
 *     current request's tenantId, injected automatically
 *   - every aggregate pipeline gets a `$match: { tenantId }` stage at
 *     position 0
 *   - every new document is stamped with tenantId on save
 *   - if there is no tenantId in context, the query THROWS instead of
 *     silently running unscoped. A missing tenant is a bug, not a wildcard.
 *
 * ESCAPE HATCH: platform/superAdmin code that must genuinely cross tenants
 * (e.g. GET /platform/tenants, cross-tenant analytics) opts out explicitly
 * and per-query with `.setOptions({ skipTenantScope: true })`. This is only
 * honoured when the request context role is 'superAdmin' — anything else
 * throws. Grep for `skipTenantScope` in code review; it should appear only
 * inside modules/platform and modules/analytics' cross-tenant rollup query.
 */

const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndRemove',
  'count',
  'countDocuments',
  'updateMany',
  'updateOne',
  'deleteMany',
  'deleteOne',
  'distinct',
] as const;

function resolveTenantFilterValue(): ReturnType<typeof requireTenantId> | null {
  const ctx = getContext();
  if (ctx?.role === 'superAdmin' && !ctx.tenantId) {
    // superAdmin acting without an explicit ?tenantId= — only valid via skipTenantScope.
    return null;
  }
  return requireTenantId();
}

export function tenantScopePlugin(schema: Schema): void {
  for (const hook of QUERY_HOOKS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema.pre(hook as any, function (this: Query<unknown, Document>) {
      const opts = this.getOptions() as { skipTenantScope?: boolean };

      if (opts.skipTenantScope) {
        const ctx = getContext();
        if (ctx?.role !== 'superAdmin') {
          throw new Error(
            `skipTenantScope was requested on a "${hook}" query by role "${ctx?.role}". ` +
              'Only superAdmin may bypass tenant isolation.',
          );
        }
        return;
      }

      const filter = this.getFilter();
      if (filter.tenantId !== undefined) {
        // Caller already scoped this explicitly (e.g. auth flows that look
        // up a user by a tenantId carried on another document, before any
        // request context exists). Trust it — no context requirement.
        return;
      }

      const tenantId = resolveTenantFilterValue();
      if (!tenantId) {
        throw new Error(
          `Tenant-scoped "${hook}" query ran with no tenantId in context and no ` +
            'skipTenantScope option. Refusing to run unscoped.',
        );
      }
      this.where({ tenantId });
    });
  }

  schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
    const opts = this.options as { skipTenantScope?: boolean };
    if (opts.skipTenantScope) {
      const ctx = getContext();
      if (ctx?.role !== 'superAdmin') {
        throw new Error('skipTenantScope on aggregate is superAdmin-only.');
      }
      return;
    }

    const tenantId = resolveTenantFilterValue();
    if (!tenantId) {
      throw new Error('Tenant-scoped aggregate ran with no tenantId in context.');
    }

    this.pipeline().unshift({ $match: { tenantId } });
  });

  // MUST be 'validate', not 'save': Mongoose runs schema validation (which
  // includes the `required: true` check on tenantId) during the 'validate'
  // phase, and that phase completes — and can already fail — before any
  // 'save' pre-hook runs. Stamping tenantId in pre('save') was too late for
  // every model whose tenantId is `required: true`; it silently worked only
  // for the write paths that happened to pass tenantId explicitly.
  schema.pre('validate', function (this: Document & { tenantId?: unknown }) {
    if (this.isNew && !this.tenantId) {
      const ctx = getContext();
      if (!ctx?.tenantId) {
        throw new Error(
          'Attempted to save a new tenant-scoped document with no tenantId in context ' +
            'and none set explicitly (e.g. by a seed script).',
        );
      }
      this.tenantId = ctx.tenantId;
    }
  });

  schema.pre('insertMany', function (docs: unknown) {
    const ctx = getContext();
    if (!ctx?.tenantId) return; // seed scripts set tenantId explicitly per-doc
    for (const doc of docs as Array<{ tenantId?: unknown }>) {
      if (!doc.tenantId) doc.tenantId = ctx.tenantId;
    }
  });
}
