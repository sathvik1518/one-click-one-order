import type { Order } from "./orderService";
import type { OrderItem } from "./cart";

/** Thrown for any non-2xx answer. `status` lets callers tell 4xx (our fault) from 5xx (server's). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readError(res: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string") message = body.detail;
  } catch {
    // The body was not JSON. Keep the fallback message.
  }
  return new ApiError(res.status, message);
}

/** Sends the order with its slip number (the Idempotency-Key). */
export async function placeOrder(
  items: OrderItem[],
  idempotencyKey: string,
  extraHeaders: Record<string, string> = {},
): Promise<Order> {
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, ...extraHeaders },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw await readError(res, "Could not place the order.");
  return ((await res.json()) as { order: Order }).order;
}

export async function getOrders(): Promise<Order[]> {
  const res = await fetch("/api/orders");
  if (!res.ok) throw await readError(res, "Could not load orders.");
  return (await res.json()) as Order[];
}
