import { test } from "node:test";
import assert from "node:assert/strict";

import { clientAddress, clientAddressKey } from "./client-address";

const at = (h: Record<string, string>) => clientAddress(new Headers(h));

test("the address is the hop Traefik appended, never the head a caller writes", () => {
  assert.equal(at({ "x-forwarded-for": "203.0.113.7" }), "203.0.113.7");
  assert.equal(
    at({ "x-forwarded-for": "6.6.6.6, 203.0.113.7", "x-real-ip": "6.6.6.6" }),
    "203.0.113.7",
  );
});

test("cf-connecting-ip counts only when the peer is Cloudflare", () => {
  assert.equal(
    at({ "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "172.68.0.9" }),
    "198.51.100.4",
  );
  assert.equal(
    at({ "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "203.0.113.7" }),
    "203.0.113.7",
  );
  assert.equal(
    at({ "cf-connecting-ip": "x".repeat(50), "x-forwarded-for": "172.68.0.9" }),
    "172.68.0.9",
  );
});

test("a rotating forged header is one bucket, not a fresh one per request", () => {
  const keys = new Set(
    ["1.1.1.1", "2.2.2.2", "2001:db8::1"].map((forged) =>
      clientAddressKey(
        new Headers({
          "cf-connecting-ip": forged,
          "x-forwarded-for": `${forged}, 203.0.113.7`,
        }),
      ),
    ),
  );
  assert.deepEqual([...keys], ["203.0.113.7"]);
});

test("no forwarded address at all is the shared unknown bucket", () => {
  assert.equal(at({ "x-real-ip": "6.6.6.6" }), null);
  assert.equal(clientAddressKey(new Headers()), "unknown");
});
