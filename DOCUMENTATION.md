# One Click, One Order: Safe Retries with an Idempotency Key

**Day 33 Mini Capstone, Server State**  
**Project folder:** `one-click-one-order`

---

## 1. Goal

A person presses **Place order**. The request reaches the server and the order is created, but the answer is lost because the network drops. The screen shows an error, so the person presses again. Without protection, the kitchen now has two orders for one meal. The same happens with a double click, a retry from a flaky connection, or a mobile app that resends when it resumes.

The task (Day 33 Deep Dive, Mini Capstone) was to make it **one click, one order**, using an **idempotency key**.

Think of a waiter who writes an order slip number on every ticket. If the same ticket reaches the kitchen twice, the cook sees the same number and makes the dish once. The slip number is the idempotency key.

The server rules are written in TypeScript, in one file that the dev server and the tests share, so the whole project stays in one place.

---

## 2. Tools

| Tool | Role |
|---|---|
| React + TypeScript (strict) | The cart screen and the types |
| TanStack Query | `useMutation` for placing the order, `useQuery` for the order count |
| Vite | Dev server and build. Its small fake API uses the real order rules |
| Vitest + jsdom | Test runner and fake browser |
| React Testing Library + user-event | Render the screen and act like a user |
| MSW | Fake server in the tests, with request recording and a "lose the answer" switch |

---

## 3. Project structure

```
one-click-one-order/
├── package.json
├── tsconfig.json
├── vite.config.ts              (fake API for npm run dev)
├── index.html
├── .gitignore
├── README.md
├── DOCUMENTATION.md
└── src/
    ├── cart.ts                  (fingerprintOf, newIdempotencyKey)
    ├── orderService.ts          (THE server rule: one key, one order)
    ├── api.ts                   (placeOrder with the Idempotency-Key header)
    ├── queryClient.ts
    ├── usePlaceOrder.ts         (THE client rule: keep the key, reuse it on retry)
    ├── CartPage.tsx             (the screen)
    ├── App.tsx
    ├── main.tsx
    ├── orderService.test.ts     (22 tests)
    ├── CartPage.test.tsx        (12 tests)
    └── test/
        ├── server.ts            (fake server using the real rules)
        ├── setup.ts             (rules for every test)
        └── renderCart.tsx       (renders the cart page)
```

---

## 4. Setup commands

```bash
mkdir one-click-one-order
cd one-click-one-order
npm init -y
npm install react react-dom @tanstack/react-query
npm install -D vite @vitejs/plugin-react typescript vitest jsdom \
  @testing-library/react @testing-library/user-event @testing-library/jest-dom \
  msw @types/react @types/react-dom @types/node
```

**`package.json` scripts**

```json
"dev": "vite",
"build": "vite build",
"test": "vitest run",
"typecheck": "tsc --noEmit"
```

---

## 5. The idea: the slip number

```
 WITHOUT a slip number                         WITH a slip number (Idempotency-Key: K)

 Click ─▶ POST ─▶ server makes order #1        Click ─▶ POST (K) ─▶ server makes order #1, saves K
          answer lost on the way back                    answer lost on the way back
 Retry ─▶ POST ─▶ server makes order #2  ✗     Retry ─▶ POST (K) ─▶ server sees K, returns order #1
                                                         still ONE order  ✓
```

**Server side (`orderService.ts`)**

| Request | Answer |
|---|---|
| New key | Create the order, `201` |
| Same key, same cart | Return the **same** order, `200`, no second order |
| Same key, different cart | Refuse, `422` |
| No key | Refuse, `400` |

**Client side (`usePlaceOrder.ts`)** keeps the key in a `ref`:

| Moment | What happens to the key |
|---|---|
| Order attempt starts | A new key is made |
| Retry, cart unchanged | The **same** key is reused |
| Cart changed | A **new** key (it is a different order) |
| Order succeeded | Key dropped. The next order is a new order |
| Server refused (4xx) | Key dropped. Nothing was created, and the fixed order needs a new key |
| Network failure or 5xx | Key **kept**. The order might exist, so the retry must be safe |

---

## 6. The code

### `src/cart.ts` (shared by the client and the server)

```ts
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
```

### `src/orderService.ts` (the server rule)

```ts
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
```

### `src/api.ts`

```ts
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
```

### `src/queryClient.ts`

```ts
import { QueryClient } from "@tanstack/react-query";

/** One place that builds the client, so the app and the tests share the same rules. */
export function createQueryClient(overrides: { retry?: boolean | number } = {}) {
  return new QueryClient({
    defaultOptions: { queries: { retry: overrides.retry ?? 1 } },
  });
}
```

### `src/usePlaceOrder.ts` (the client rule, the heart of the capstone)

```ts
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
```

### `src/CartPage.tsx`

```tsx
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
```

### `src/App.tsx`

```tsx
import CartPage from "./CartPage";

export default function App() {
  return <CartPage showDemoControls />;
}
```

### `src/main.tsx`

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { createQueryClient } from "./queryClient";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

### `vite.config.ts` (test setup, and the fake API for `npm run dev`)

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { createOrderService, toHttp } from "./src/orderService";

/**
 * A tiny fake server for `npm run dev`, using the SAME rules as the tests
 * (src/orderService.ts). Data lives in memory and resets on restart.
 *   POST /api/orders  (needs an Idempotency-Key header)
 *   GET  /api/orders
 * Demo trick: send the header `X-Demo-Lose-Answer: 1` and the order is created,
 * but the connection is cut before the answer arrives. This is the exact problem
 * the Idempotency-Key solves.
 */
function fakeApi(): Plugin {
  const service = createOrderService();
  return {
    name: "fake-api",
    configureServer(server) {
      server.middlewares.use("/api/orders", (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method === "GET") return send(200, service.list());
        if (req.method !== "POST") return send(405, { detail: "Method not allowed" });

        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const key = req.headers["idempotency-key"];
          let items: unknown;
          try {
            items = (JSON.parse(raw || "{}") as { items?: unknown }).items;
          } catch {
            items = undefined;
          }
          const result = toHttp(service.place(typeof key === "string" ? key : null, items));
          // Slow on purpose, so "Placing order..." can be seen by eye.
          setTimeout(() => {
            if (req.headers["x-demo-lose-answer"] === "1" && result.status === 201) {
              res.destroy(); // the order exists, but the answer never arrives
              return;
            }
            send(result.status, result.body);
          }, 600);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), fakeApi()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

### Design decisions

| Decision | Reason |
|---|---|
| The key is kept in a `ref`, not in state | Changing it must not cause a re-render, and it must survive between attempts. |
| Reuse the key while the cart is unchanged | This is the whole trick. A retry of the same order carries the same slip number. |
| `fingerprintOf` compares carts, ignoring the order of lines | "Idli then Dosa" and "Dosa then Idli" are the same order. The same function is used by the client and the server. |
| A **ref** guards against a second click, not only a disabled button | Two clicks can happen before React re-renders, so the button is not disabled yet. A ref changes at once. |
| Disabled button and "Placing order..." as well | The ref protects the logic. The disabled button tells the person something is happening. |
| Look up the key and store the order in one step, with no `await` between | Two requests can never run in the middle of each other, so five requests at once still make one order. In a real database, use a UNIQUE constraint on the key. |
| Same key with a different cart is refused (`422`) | A reused key for something else is a bug. Quietly returning the old order would hide it. |
| A missing key is refused (`400`) | The protection only works if every order carries a key. Failing loudly makes a missing key easy to find. |
| Drop the key after a 4xx, keep it after a network error or 5xx | A 4xx means nothing was created. A network error or 5xx means the order might exist, so the retry must be safe. |
| Empty the cart only when the server confirmed the order | If the answer was lost, the person still sees their cart and can retry. |
| A friendly retry message: "You will not be charged twice" | The person needs to know that pressing again is safe. That is true because of the key. |
| The server's own message is shown for a 4xx | "That item is sold out" is more useful than a generic error. |
| After every attempt, the order list is refetched | "Orders on the server" shows the truth, so you can see that a retry did not add an order. |
| `newIdempotencyKey` has a fallback | `crypto.randomUUID` only exists on secure pages (https or localhost). The fallback keeps the app working on plain http. |
| The test server uses the real `orderService` | The tests check the real rule, not a copy that could drift. |

---

## 7. Tests (34 tests)

The tests have two files. **`orderService.test.ts`** checks the server rule on its own. **`CartPage.test.tsx`** checks the screen against a fake server that uses the same rule. The "answer is lost" case is a test switch: the fake server creates the order and then fails the request, exactly like a dropped network.

| # | Test | What it proves |
|---|---|---|
| 1 | New key creates an order (201) | Basic success |
| 2 | Same key and cart returns the same order, no second order | The main server rule |
| 3 | Same items in a different order count as the same cart | Fingerprint ignores line order |
| 4 | Same key with a different cart is refused (422) | A reused key is caught |
| 5 | Different keys make two orders | Keys are what separate orders |
| 6 to 8 | Missing, empty or blank key is refused (400) | The key is required |
| 9 to 17 | Invalid carts are refused (422): not a list, empty, quantity 0, fractional, over 99, missing sku, blank sku, text quantity, `null` line | Bad input never makes an order |
| 18 | Five requests with the same key at once make one order | Safe under a double click |
| 19 | A refused request does not keep its key | A fixed order can use the key later |
| 20 to 22 | `fingerprintOf`: same for any line order, changes with a quantity, changes with a new item | The comparison is right |
| 23 | Click once: one POST with a key, one order, cart emptied | The normal path |
| 24 | "Placing order..." and a disabled button while waiting | Waiting state |
| 25 | Double click: one POST, one order | Goal: one click, one order |
| 26 | Two clicks in the same moment (before a re-render): one POST | The ref guard works |
| 27 | Answer lost: retry reuses the same key, still one order, count shows 1 | The capstone problem, solved |
| 28 | After a failed attempt the cart is kept | The person can retry |
| 29 | Cart changed after a failure: a new key | A different order is a different order |
| 30 | Next order after a success: a new key, two real orders | Keys are not reused across orders |
| 31 | Server refuses (422): its message is shown, the key is not reused | 4xx handling |
| 32 | Server error (500): friendly message, same key reused on retry | 5xx handling |
| 33 | Empty cart: button disabled, no request | No pointless orders |
| 34 | "Orders on the server" goes from 0 to 1 | The screen shows the truth |

### `src/test/server.ts` (fake server using the real rules)

```ts
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import { createOrderService, toHttp } from "../orderService";

/** The fake server uses the REAL order rules, so the tests check the real behaviour. */
export let service = createOrderService();

/** A record of what the app sent, and switches the tests can flip. */
export const calls: { key: string | null; items: unknown }[] = [];
export const control = { loseNextAnswers: 0 };

export function resetServerState() {
  service = createOrderService();
  calls.length = 0;
  control.loseNextAnswers = 0;
}

export const handlers = [
  http.post("*/api/orders", async ({ request }) => {
    const key = request.headers.get("Idempotency-Key");
    const body = (await request.json()) as { items?: unknown };
    calls.push({ key, items: body.items });

    const { status, body: json } = toHttp(service.place(key, body.items));

    if (control.loseNextAnswers > 0) {
      control.loseNextAnswers -= 1;
      return HttpResponse.error(); // the order was created, but the answer is lost
    }
    return HttpResponse.json(json as Record<string, unknown>, { status });
  }),

  http.get("*/api/orders", () => HttpResponse.json(service.list())),
];

export const server = setupServer(...handlers);
```

### `src/test/setup.ts`

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { resetServerState, server } from "./server";

// Any request without a fake answer fails the test.
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));

beforeEach(() => resetServerState());

// After every test: clean the screen and drop per-test fake answers.
afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => server.close());
```

### `src/test/renderCart.tsx`

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CartPage from "../CartPage";
import { createQueryClient } from "../queryClient";

export function renderCart() {
  const client = createQueryClient({ retry: false });
  render(
    <QueryClientProvider client={client}>
      <CartPage />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), client };
}
```

### `src/orderService.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fingerprintOf } from "./cart";
import { createOrderService } from "./orderService";

const idliAndDosa = [
  { sku: "Idli", qty: 2 },
  { sku: "Dosa", qty: 1 },
];

describe("orderService: the slip-number rule", () => {
  it("creates an order for a new key (201)", () => {
    const service = createOrderService();
    const result = service.place("key-1", idliAndDosa);

    expect(result).toMatchObject({ status: 201, replayed: false });
    expect(service.list()).toHaveLength(1);
  });

  it("returns the SAME order for the same key and cart, and makes no second order", () => {
    const service = createOrderService();
    const first = service.place("key-1", idliAndDosa);
    const second = service.place("key-1", idliAndDosa);

    expect(second).toMatchObject({ status: 200, replayed: true });
    expect("order" in first && "order" in second && second.order.id === first.order.id).toBe(true);
    expect(service.list()).toHaveLength(1);
  });

  it("treats the same items in a different order as the same cart", () => {
    const service = createOrderService();
    service.place("key-1", idliAndDosa);
    const again = service.place("key-1", [...idliAndDosa].reverse());

    expect(again).toMatchObject({ status: 200, replayed: true });
    expect(service.list()).toHaveLength(1);
  });

  it("refuses the same key with a different cart (422) and makes no second order", () => {
    const service = createOrderService();
    service.place("key-1", idliAndDosa);
    const result = service.place("key-1", [{ sku: "Idli", qty: 5 }]);

    expect(result).toMatchObject({ status: 422 });
    expect(service.list()).toHaveLength(1);
  });

  it("makes two orders for two different keys", () => {
    const service = createOrderService();
    service.place("key-1", idliAndDosa);
    service.place("key-2", idliAndDosa);

    expect(service.list().map((order) => order.id)).toEqual([1, 2]);
  });

  it.each([null, "", "   "])("refuses a missing or blank key (%j) with 400", (key) => {
    const service = createOrderService();
    expect(service.place(key, idliAndDosa)).toMatchObject({ status: 400 });
    expect(service.list()).toHaveLength(0);
  });

  it.each([
    ["not a list", "Idli"],
    ["an empty list", []],
    ["quantity 0", [{ sku: "Idli", qty: 0 }]],
    ["a fractional quantity", [{ sku: "Idli", qty: 1.5 }]],
    ["quantity over 99", [{ sku: "Idli", qty: 100 }]],
    ["a missing sku", [{ qty: 1 }]],
    ["a blank sku", [{ sku: "  ", qty: 1 }]],
    ["a text quantity", [{ sku: "Idli", qty: "2" }]],
    ["null inside the list", [null]],
  ])("refuses an invalid cart: %s (422)", (_label, body) => {
    const service = createOrderService();
    expect(service.place("key-1", body)).toMatchObject({ status: 422 });
    expect(service.list()).toHaveLength(0);
  });

  it("makes ONE order when many requests with the same key arrive at once", async () => {
    const service = createOrderService();
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => service.place("key-1", idliAndDosa)),
    );

    expect(service.list()).toHaveLength(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
  });

  it("does not keep a key for a refused request", () => {
    const service = createOrderService();
    service.place("key-1", []); // refused, nothing created
    const result = service.place("key-1", idliAndDosa); // the same key can now be used for a valid cart

    expect(result).toMatchObject({ status: 201 });
  });
});

describe("fingerprintOf", () => {
  it("is the same whatever the order of the lines", () => {
    expect(fingerprintOf(idliAndDosa)).toBe(fingerprintOf([...idliAndDosa].reverse()));
  });

  it("changes when a quantity changes", () => {
    expect(fingerprintOf(idliAndDosa)).not.toBe(fingerprintOf([{ sku: "Idli", qty: 3 }, { sku: "Dosa", qty: 1 }]));
  });

  it("changes when an item is added", () => {
    expect(fingerprintOf(idliAndDosa)).not.toBe(fingerprintOf([...idliAndDosa, { sku: "Vada", qty: 1 }]));
  });
});
```

### `src/CartPage.test.tsx`

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { calls, control, server, service } from "./test/server";
import { renderCart } from "./test/renderCart";

const placeButton = () => screen.getByRole("button", { name: /place order|placing order/i });

/** A server answer we release by hand, so the first request is still running when the test clicks again. */
function holdAnswers() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  server.use(
    http.post("*/api/orders", async ({ request }) => {
      const key = request.headers.get("Idempotency-Key");
      const body = (await request.json()) as { items?: unknown };
      calls.push({ key, items: body.items });
      const result = service.place(key, body.items);
      await gate;
      if ("error" in result) return HttpResponse.json({ detail: result.error }, { status: result.status });
      return HttpResponse.json({ order: result.order, replayed: result.replayed }, { status: result.status });
    }),
  );
  return release;
}

describe("Cart page: one click, one order", () => {
  it("places one order with an Idempotency-Key and empties the cart", async () => {
    const { user } = renderCart();
    await user.click(placeButton());

    expect(await screen.findByText("Order #1 placed. Thank you!")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toEqual(expect.any(String));
    expect(calls[0]?.key).not.toBe("");
    expect(service.list()).toHaveLength(1);
    expect(screen.getByText("Your cart is empty.")).toBeInTheDocument();
  });

  it("shows 'Placing order...' and disables the button while waiting", async () => {
    const release = holdAnswers();
    const { user } = renderCart();
    await user.click(placeButton());

    const busy = await screen.findByRole("button", { name: "Placing order..." });
    expect(busy).toBeDisabled();

    release();
    expect(await screen.findByText("Order #1 placed. Thank you!")).toBeInTheDocument();
  });

  it("makes ONE order on a double click", async () => {
    const release = holdAnswers();
    const { user } = renderCart();

    await user.dblClick(placeButton());
    release();

    expect(await screen.findByText("Order #1 placed. Thank you!")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(service.list()).toHaveLength(1);
  });

  it("makes ONE order even for two clicks before React re-renders", async () => {
    const release = holdAnswers();
    renderCart();
    const button = placeButton();

    fireEvent.click(button); // both clicks happen in the same moment,
    fireEvent.click(button); // so the button is not disabled yet

    release();
    expect(await screen.findByText("Order #1 placed. Thank you!")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("when the answer is lost, a retry reuses the SAME key and makes no second order", async () => {
    control.loseNextAnswers = 1;
    const { user } = renderCart();

    await user.click(placeButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not confirm your order");
    expect(service.list()).toHaveLength(1); // the server DID create the order

    await user.click(placeButton());

    expect(await screen.findByText("Order #1 placed. Thank you!")).toBeInTheDocument();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(service.list()).toHaveLength(1); // still ONE order
    expect(await screen.findByText("Orders on the server: 1")).toBeInTheDocument();
  });

  it("keeps the cart after a failed attempt, so the person can retry", async () => {
    control.loseNextAnswers = 1;
    const { user } = renderCart();
    await user.click(placeButton());
    await screen.findByRole("alert");

    expect(screen.getByText("Idli x 2")).toBeInTheDocument();
    expect(screen.getByText("Dosa x 1")).toBeInTheDocument();
  });

  it("uses a NEW key when the cart changes after a failed attempt", async () => {
    control.loseNextAnswers = 1;
    const { user } = renderCart();
    await user.click(placeButton());
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Add one Idli" }));
    await user.click(placeButton());
    await screen.findByText(/Order #\d+ placed/);

    expect(calls[1]?.key).not.toBe(calls[0]?.key);
  });

  it("uses a NEW key for the next order after a success", async () => {
    const { user } = renderCart();
    await user.click(placeButton());
    await screen.findByText("Order #1 placed. Thank you!");

    await user.click(screen.getByRole("button", { name: "Start a new order" }));
    await user.click(placeButton());

    expect(await screen.findByText("Order #2 placed. Thank you!")).toBeInTheDocument();
    expect(calls[1]?.key).not.toBe(calls[0]?.key);
    expect(service.list()).toHaveLength(2); // a second, intended order is a real second order
  });

  it("shows the server's own message for a refusal (422) and does not reuse that key", async () => {
    server.use(
      http.post(
        "*/api/orders",
        async ({ request }) => {
          calls.push({ key: request.headers.get("Idempotency-Key"), items: null });
          return HttpResponse.json({ detail: "That item is sold out." }, { status: 422 });
        },
        { once: true },
      ),
    );
    const { user } = renderCart();

    await user.click(placeButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("That item is sold out.");

    await user.click(placeButton()); // the default handler answers this time
    await screen.findByText("Order #1 placed. Thank you!");
    expect(calls[1]?.key).not.toBe(calls[0]?.key);
  });

  it("keeps the key after a server error (500), because the order might exist", async () => {
    server.use(
      http.post(
        "*/api/orders",
        async ({ request }) => {
          calls.push({ key: request.headers.get("Idempotency-Key"), items: null });
          return new HttpResponse(null, { status: 500 });
        },
        { once: true },
      ),
    );
    const { user } = renderCart();

    await user.click(placeButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not confirm your order");

    await user.click(placeButton());
    await screen.findByText("Order #1 placed. Thank you!");
    expect(calls[1]?.key).toBe(calls[0]?.key);
  });

  it("sends no request when the cart is empty", async () => {
    const { user } = renderCart();
    await user.click(screen.getByRole("button", { name: "Remove one Idli" }));
    await user.click(screen.getByRole("button", { name: "Remove one Idli" }));
    await user.click(screen.getByRole("button", { name: "Remove one Dosa" }));

    expect(screen.getByText("Your cart is empty.")).toBeInTheDocument();
    expect(placeButton()).toBeDisabled();
    await waitFor(() => expect(calls).toHaveLength(0));
  });

  it("shows how many orders the server has", async () => {
    const { user } = renderCart();
    expect(await screen.findByText("Orders on the server: 0")).toBeInTheDocument();

    await user.click(placeButton());
    expect(await screen.findByText("Orders on the server: 1")).toBeInTheDocument();
  });
});
```

---

## 8. Results

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | No errors |
| Tests | `npm test` | **34 passed** (2 files) |
| Build | `npm run build` | Built successfully |
| Real HTTP check | Dev server: lost answer, then retry with the same key | 1 order on the server. The retry returned the same order (`200`, replayed). A different cart with that key got `422`. No key got `400`. |
| Break-it check 1 | Made a new key on every click | **2 tests failed** |
| Break-it check 2 | Server ignores the key | **5 tests failed** |
| Break-it check 3 | Removed the guard against a second click | **1 test failed** (the two-clicks-at-once test) |
| Break-it check 4 | Kept the key after a refusal | **1 test failed** |
| Break-it check 5 | Dropped the key after a server error | **1 test failed** |
| Restored original | Type check and tests | No errors, 34 passed |

---

## 9. Problems avoided

| Problem | Cause | Fix |
|---|---|---|
| Duplicate order after a lost answer | The retry looked like a brand new order | The same key is reused on retry. The server returns the first order |
| Duplicate order on a double click | Two clicks happen before React re-renders, so the button is still enabled | A `ref` guard blocks the second click at once |
| Two requests with the same key at the same moment | "Check then save" split across an `await` lets both through | Check and save happen in one step. In a real database, use a UNIQUE constraint |
| A key reused for a different order | Silent reuse would return the wrong order | Server refuses with `422`. The client makes a new key when the cart changes |
| A stuck key after a refusal | The server created nothing, but the client kept the key | Drop the key after a 4xx |
| A lost cart after a lost answer | Emptying the cart before the server confirmed | Empty it only after success |

---

## 10. What was practiced

- Understanding idempotency: doing the same request twice has the same effect as doing it once.
- Designing both sides: the server remembers the key, and the client keeps the key across retries.
- Choosing when to keep or drop the key: success, refusal, network failure, cart change.
- Using a `ref` to guard against a double click when state would be too slow.
- Making "check, then save" one step so concurrent requests cannot both succeed.
- Handling errors by kind: 4xx (show the server's message) and network or 5xx (safe to retry).
- Testing a lost network answer: the fake server creates the order and then fails the request.
- Checking that tests are real by breaking the code on purpose and watching them fail.

---

## 11. Known limit

The server keeps orders and keys in memory, so they reset when the dev server restarts. Keys are never cleaned up; a real server removes them after some time (for example 24 hours). If the answer is lost and the person then **changes the cart**, the first order still exists on the server, and the changed cart makes a second one. That is the correct rule (a different cart is a different order), but the person should be told to check their orders first. The course server is FastAPI. The same three checks (key present, same key with same cart returns the saved order, same key with another cart is refused) work there, with a UNIQUE constraint on the key.

---

## 12. How to run it

```bash
cd one-click-one-order
npm install
npm test            # 34 tests
npm run typecheck   # type check
npm run dev         # open the link and try the demo
```

**Try the demo in the browser:** tick "Pretend the server's answer gets lost", then press **Place order**. You see the retry message, and "Orders on the server: 1". Press **Place order** again: it succeeds with **Order #1**, and the count stays at 1. Untick the box and place another order to see a new order (#2).
