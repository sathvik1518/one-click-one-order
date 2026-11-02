# one-click-one-order

Safe retries for "Place order" with an idempotency key. The server returns the same order for the same key, and the client reuses the key on retries, so a lost answer or a double click never makes two orders.

```bash
npm install
npm test
npm run typecheck
npm run dev
```

See `DOCUMENTATION.md` for the full write-up.
