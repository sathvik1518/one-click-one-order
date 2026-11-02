import { useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, placeOrder } from "./api";
import type { Order } from "./orderService";
import { fingerprintOf, newIdempotencyKey, type OrderItem } from "./cart";

export const ORDERS_KEY = ["orders"] as const;

/**
 * "One click, one order."
 *
 * The slip number (idempotency key) is kept in a ref:
 *  - It is made when an order attempt starts.
 *  - It is REUSED on every retry while the cart is unchanged, so if the first
 *    answer was lost, the retry cannot make a second order.
 *  - It is dropped when the order succeeds, when the server rejects the order
 *    (nothing was created), or when the cart changes (it is a different order).
 */
export function usePlaceOrder(options: { demoLoseAnswer?: boolean } = {}) {
  const queryClient = useQueryClient();
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: ({ items, key }: { items: OrderItem[]; key: string }) =>
      placeOrder(items, key, options.demoLoseAnswer ? { "X-Demo-Lose-Answer": "1" } : {}),
    onSuccess: () => {
      attempt.current = null; // done: the next order gets a new slip number
    },
    onError: (error) => {
      // A 4xx means the server refused and created nothing, so a fixed order needs a new key.
      // A network failure or 5xx might still have created the order, so KEEP the key.
      if (error instanceof ApiError && error.status < 500) attempt.current = null;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ORDERS_KEY }),
  });

  const place = useCallback(
    async (items: OrderItem[]): Promise<Order | null> => {
      // A second click while the first request is still running does nothing.
      // A ref is used (not state), because two clicks can happen before React re-renders.
      if (inFlight.current) return null;
      inFlight.current = true;

      const fingerprint = fingerprintOf(items);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
        attempt.current = { key: newIdempotencyKey(), fingerprint };
      }

      try {
        return await mutation.mutateAsync({ items, key: attempt.current.key });
      } catch {
        return null; // the error is shown from `mutation.error`
      } finally {
        inFlight.current = false;
      }
    },
    [mutation],
  );

  return { place, isPlacing: mutation.isPending, error: mutation.error };
}
