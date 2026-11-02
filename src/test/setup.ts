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
