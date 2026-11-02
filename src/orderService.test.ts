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
