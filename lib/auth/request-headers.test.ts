import { test } from "node:test";
import assert from "node:assert/strict";

import { authRequestHeaders } from "./request-headers";

/**
 * Both halves of this selection fail SILENTLY, which is why they are pinned.
 *
 * Drop `user-agent` and the signed-in-devices table still renders — every row
 * just says "Unknown device" forever, and nothing anywhere reports an error.
 * Add `origin` and logins keep working on the canonical host while quietly
 * breaking on every other host the instance answers on.
 */

const request = new Headers({
  "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120.0.0.0",
  "x-forwarded-for": "203.0.113.7, 10.0.0.1",
  "cf-connecting-ip": "203.0.113.7",
  origin: "https://apps.example.com",
  referer: "https://apps.example.com/login",
  host: "apps.example.com",
  cookie: "deplo.session_token=stale-pre-login-value",
  authorization: "Bearer deplo_something",
});

test("the session metadata Better Auth stamps onto a new session is forwarded", () => {
  const out = authRequestHeaders(request, "deplo.session_token=fresh");
  assert.equal(out.get("user-agent"), "Mozilla/5.0 (Macintosh) Chrome/120.0.0.0");
  assert.equal(out.get("x-forwarded-for"), "203.0.113.7, 10.0.0.1");
  assert.equal(out.get("cf-connecting-ip"), "203.0.113.7");
});

test("origin, referer and host are NOT forwarded", () => {
  // They would be matched against `trustedOrigins` (which defaults to
  // DEPLO_PUBLIC_URL) and reject every login on a host that is not that one.
  const out = authRequestHeaders(request, "");
  for (const name of ["origin", "referer", "host"])
    assert.equal(out.get(name), null, `${name} must not be forwarded`);
});

test("nothing else rides along either", () => {
  const out = authRequestHeaders(request, "");
  assert.equal(out.get("authorization"), null, "the bearer token is not relayed");
  assert.deepEqual(
    [...out.keys()].sort(),
    ["cf-connecting-ip", "user-agent", "x-forwarded-for"],
    "the forwarded set is exactly the documented one",
  );
});

test("the supplied cookie wins over the request's own", () => {
  // The cookie STORE sees writes made earlier in this request; the raw request
  // headers still carry the pre-login value.
  const out = authRequestHeaders(request, "deplo.session_token=fresh");
  assert.equal(out.get("cookie"), "deplo.session_token=fresh");
});

test("an empty cookie string sets no cookie header at all", () => {
  // After logout there is nothing to send, and an empty `cookie:` header is not
  // the same thing as no header.
  const out = authRequestHeaders(request, "");
  assert.equal(out.get("cookie"), null);
});

test("no request scope degrades to cookie-only rather than throwing", () => {
  const out = authRequestHeaders(null, "deplo.session_token=abc");
  assert.equal(out.get("cookie"), "deplo.session_token=abc");
  assert.equal(out.get("user-agent"), null);
});

test("a request with none of the metadata headers yields just the cookie", () => {
  const out = authRequestHeaders(new Headers(), "a=b");
  assert.deepEqual([...out.keys()], ["cookie"]);
});
