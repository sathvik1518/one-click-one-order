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
