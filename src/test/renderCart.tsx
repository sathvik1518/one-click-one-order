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
