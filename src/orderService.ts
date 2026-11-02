/**
 * The server's rule for "one click, one order".
 *
 * Every order request carries an Idempotency-Key (a slip number).
 *  - New key             -> create the order           (201)
 *  - Same key, same cart -> return the SAME order      (200, replayed)
 *  - Same key, other cart-> refuse                     (422)
 *  - No key              -> refuse                     (400)
 *
 * This is plain TypeScript so the same rules run in the dev server and in the tests.
 */
import { fingerprintOf, type OrderItem } from "./cart";

export type Order = { id: number; items: OrderItem[] };

export type PlaceResult =
  | { status: 201; order: Order; replayed: false }
  | { status: 200; order: Order; replayed: true }
  | { status: 400 | 422; error: string };

const MAX_QTY = 99;

/** Accept only a non-empty list of items with a whole-number quantity. */
function parseItems(input: unknown): OrderItem[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const items: OrderItem[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) return null;
    const { sku, qty } = raw as { sku?: unknown; qty?: unknown };
    if (typeof sku !== "string" || sku.trim() === "") return null;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return null;
    items.push({ sku, qty });
  }
  return items;
}

export function createOrderService() {
  const orders: Order[] = [];
  const byKey = new Map<string, { fingerprint: string; order: Order }>();

  /**
   * IMPORTANT: the "look up the key, then store it" part below is ONE step
   * with no `await` in the middle. In JavaScript, two requests can never run
   * in the middle of each other, so two clicks at once still make one order.
   * In a real database you get the same safety from a UNIQUE constraint on the key.
   */
  function place(key: string | null, body: unknown): PlaceResult {
    if (key === null || key.trim() === "") {
      return { status: 400, error: "The Idempotency-Key header is required." };
    }
    const items = parseItems(body);
    if (!items) {
      return { status: 422, error: "An order needs at least one item with a quantity from 1 to 99." };
    }

    const fingerprint = fingerprintOf(items);
    const seen = byKey.get(key);
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        return { status: 422, error: "That key was already used for a different order." };
      }
      return { status: 200, order: seen.order, replayed: true };
    }

    const order: Order = { id: orders.length + 1, items };
    orders.push(order);
    byKey.set(key, { fingerprint, order });
    return { status: 201, order, replayed: false };
  }

  return { place, list: (): Order[] => [...orders] };
}

/** Turns a result into an HTTP status and JSON body. Shared by the dev server and the tests. */
export function toHttp(result: PlaceResult): { status: number; body: unknown } {
  if ("error" in result) return { status: result.status, body: { detail: result.error } };
  return { status: result.status, body: { order: result.order, replayed: result.replayed } };
}
