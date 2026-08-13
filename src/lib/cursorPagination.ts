import { Types } from 'mongoose';

/**
 * §12 PAGINATION — cursor pagination for lists that move (order queues, the
 * credit ledger, audit log). Cursor is base64 of { sortValue, _id }, always
 * tie-broken on _id so the sort is total even when two rows share a
 * timestamp.
 */

export type Cursor = { sortValue: string | number; id: string };

export function encodeCursor(sortValue: string | number, id: string): string {
  return Buffer.from(JSON.stringify({ sortValue, id })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (typeof parsed.id !== 'string' || !Types.ObjectId.isValid(parsed.id)) return null;
    return parsed as Cursor;
  } catch {
    return null;
  }
}

/**
 * Builds a $or filter for "strictly after this cursor" on a query sorted by
 * `sortField` DESC, `_id` DESC (the convention every cursor list in this
 * project uses).
 */
export function cursorFilter(sortField: string, cursor: Cursor | null): Record<string, unknown> {
  if (!cursor) return {};
  return {
    $or: [
      { [sortField]: { $lt: cursor.sortValue } },
      { [sortField]: cursor.sortValue, _id: { $lt: new Types.ObjectId(cursor.id) } },
    ],
  };
}
