/**
 * §9.1 — both chains already exist in the app (data/types.ts: DELIVERY_FLOW,
 * PICKUP_FLOW). The server owns them here. Status spellings inside the
 * curbside chain keep the app's existing names even though the fulfillment
 * type is now "curbside" (A3 / §25.3).
 */

export type OrderStatus =
  | 'placed'
  | 'packed'
  | 'out_for_delivery'
  | 'delivered'
  | 'ready_for_pickup'
  | 'customer_arrived'
  | 'handed_over'
  | 'cancelled';

export type Fulfillment = 'delivery' | 'curbside';

export const DELIVERY_FLOW: OrderStatus[] = ['placed', 'packed', 'out_for_delivery', 'delivered'];

export const CURBSIDE_FLOW: OrderStatus[] = [
  'placed',
  'packed',
  'ready_for_pickup',
  'customer_arrived',
  'handed_over',
];

export function flowFor(fulfillment: Fulfillment): OrderStatus[] {
  return fulfillment === 'curbside' ? CURBSIDE_FLOW : DELIVERY_FLOW;
}

/** §9.2 — only forward transitions along the order's own chain, or to cancelled from placed/packed. */
export function canTransition(fulfillment: Fulfillment, from: OrderStatus, to: OrderStatus): boolean {
  if (to === 'cancelled') {
    return from === 'placed' || from === 'packed';
  }
  const flow = flowFor(fulfillment);
  const fromIdx = flow.indexOf(from);
  const toIdx = flow.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx === fromIdx + 1;
}

export function isTerminal(status: OrderStatus): boolean {
  return status === 'delivered' || status === 'handed_over' || status === 'cancelled';
}
