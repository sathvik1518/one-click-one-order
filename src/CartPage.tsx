import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOrders } from "./api";
import type { OrderItem } from "./cart";
import type { Order } from "./orderService";
import { ORDERS_KEY, usePlaceOrder } from "./usePlaceOrder";

const START_CART: OrderItem[] = [
  { sku: "Idli", qty: 2 },
  { sku: "Dosa", qty: 1 },
];

function messageFor(error: Error): string {
  // A server refusal (4xx) has its own words. Anything else (network, 5xx) is safe to retry.
  if ("status" in error && typeof error.status === "number" && error.status < 500) return error.message;
  return "We could not confirm your order. Press Place order again. You will not be charged twice.";
}

export default function CartPage({ showDemoControls = false }: { showDemoControls?: boolean }) {
  const [cart, setCart] = useState<OrderItem[]>(START_CART);
  const [placed, setPlaced] = useState<Order | null>(null);
  const [demoLoseAnswer, setDemoLoseAnswer] = useState(false);
  const { place, isPlacing, error } = usePlaceOrder({ demoLoseAnswer });
  const orders = useQuery({ queryKey: ORDERS_KEY, queryFn: getOrders });

  function change(sku: string, delta: number) {
    setPlaced(null);
    setCart((lines) =>
      lines
        .map((line) => (line.sku === sku ? { ...line, qty: line.qty + delta } : line))
        .filter((line) => line.qty > 0),
    );
  }

  async function onPlace() {
    setPlaced(null);
    const order = await place(cart);
    if (order) {
      setPlaced(order);
      setCart([]); // the cart is emptied only when the server confirmed the order
    }
  }

  return (
    <main>
      <h1>Your cart</h1>

      {cart.length === 0 ? (
        <p>Your cart is empty.</p>
      ) : (
        <ul>
          {cart.map((line) => (
            <li key={line.sku}>
              {line.sku} x {line.qty}{" "}
              <button type="button" onClick={() => change(line.sku, 1)} aria-label={`Add one ${line.sku}`}>
                +
              </button>{" "}
              <button type="button" onClick={() => change(line.sku, -1)} aria-label={`Remove one ${line.sku}`}>
                -
              </button>
            </li>
          ))}
        </ul>
      )}

      <button type="button" onClick={onPlace} disabled={isPlacing || cart.length === 0}>
        {isPlacing ? "Placing order..." : "Place order"}
      </button>

      {error && !isPlacing && <p role="alert">{messageFor(error)}</p>}
      <p role="status">{placed ? `Order #${placed.id} placed. Thank you!` : ""}</p>
      {placed && (
        <button
          type="button"
          onClick={() => {
            setPlaced(null);
            setCart(START_CART);
          }}
        >
          Start a new order
        </button>
      )}

      <p>Orders on the server: {orders.data ? orders.data.length : "..."}</p>

      {showDemoControls && (
        <fieldset>
          <legend>Demo controls</legend>
          <label>
            <input type="checkbox" checked={demoLoseAnswer} onChange={(e) => setDemoLoseAnswer(e.target.checked)} />{" "}
            Pretend the server's answer gets lost on the way back
          </label>
        </fieldset>
      )}
    </main>
  );
}
