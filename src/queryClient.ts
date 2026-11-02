import { QueryClient } from "@tanstack/react-query";

/** One place that builds the client, so the app and the tests share the same rules. */
export function createQueryClient(overrides: { retry?: boolean | number } = {}) {
  return new QueryClient({
    defaultOptions: { queries: { retry: overrides.retry ?? 1 } },
  });
}
