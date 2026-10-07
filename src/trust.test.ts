import { expect, test } from "bun:test";
import { isTrusted } from "./trust";

const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
const req = (url: string, origin?: string) =>
  new Request(url, { headers: origin ? { origin } : {} });

test("isTrusted allows same-origin and Origin-less local requests", () => {
  expect(isTrusted(req("http://localhost:3456/state"), local)).toBe(true);
  expect(
    isTrusted(req("http://127.0.0.1:3456/x", "http://127.0.0.1:3456"), local),
  ).toBe(true);
});

test("isTrusted rejects other sites and DNS rebinding", () => {
  expect(
    isTrusted(
      req("http://localhost:3456/message", "https://evil.example"),
      local,
    ),
  ).toBe(false);
  expect(
    isTrusted(req("http://localhost:3456/x", "http://localhost:9999"), local),
  ).toBe(false);
  expect(
    isTrusted(
      req("http://evil.example:3456/x", "http://evil.example:3456"),
      local,
    ),
  ).toBe(false);
  expect(isTrusted(req("http://localhost:3456/x", "null"), local)).toBe(false);
});
