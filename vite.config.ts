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
