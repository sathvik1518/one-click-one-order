export type OrderItem = { sku: string; qty: number };

/**
 * A short text that is the same for the same cart, whatever the order of the lines.
 * The client uses it to decide "is this still the same order?",
 * and the server uses it to catch a key reused for a different order.
 */
export function fingerprintOf(items: readonly OrderItem[]): string {
  const sorted = [...items].sort((a, b) => a.sku.localeCompare(b.sku) || a.qty - b.qty);
  return JSON.stringify(sorted.map((item) => [item.sku, item.qty]));
}

/** A fresh slip number. Falls back for browsers where randomUUID is missing (plain http). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
