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
