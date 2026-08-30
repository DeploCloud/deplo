import { test } from "node:test";
import assert from "node:assert/strict";

import { authRequestHeaders } from "./request-headers";

/**
 * Both halves of this selection fail SILENTLY, which is why they are pinned.
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
  assert.equal(
    out.get("user-agent"),
    "Mozilla/5.0 (Macintosh) Chrome/120.0.0.0",
  );
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
  assert.equal(
    out.get("authorization"),
    null,
    "the bearer token is not relayed",
  );
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
  assert.match(
    out.get("cookie") ?? "",
    /(^|; )deplo\.session_token=fresh(;|$)/,
  );
  assert.doesNotMatch(out.get("cookie") ?? "", /stale-pre-login-value/);
});

test("an empty cookie string sets no cookie header at all", () => {
  // After logout there is nothing to send, and an empty `cookie:` header is not
  // the same thing as no header.
  const out = authRequestHeaders(request, "");
  assert.equal(out.get("cookie"), null);
});

test("no request scope degrades to cookie-only rather than throwing", () => {
  const out = authRequestHeaders(null, "deplo.session_token=abc");
  assert.match(out.get("cookie") ?? "", /(^|; )deplo\.session_token=abc(;|$)/);
  assert.equal(out.get("user-agent"), null);
});

test("a request with none of the metadata headers yields just the cookie", () => {
  const out = authRequestHeaders(new Headers(), "a=b");
  assert.deepEqual([...out.keys()], ["cookie"]);
});

/**
 * The panel answers on two addresses at once - its own, usually https, and its
 * server's plain-http `http://<ip>:3000` backup - so the session cookie exists
 * under two names depending on which one it was opened at.
 */
test("a plain-named auth cookie is also offered under __Secure-", () => {
  const out = authRequestHeaders(null, "deplo.session_token=abc");
  assert.match(out.get("cookie") ?? "", /__Secure-deplo\.session_token=abc/);
});

test("a __Secure- auth cookie is also offered under its plain name", () => {
  const out = authRequestHeaders(null, "__Secure-deplo.two_factor=xyz");
  assert.match(out.get("cookie") ?? "", /(^|; )deplo\.two_factor=xyz(;|$)/);
});

test("a name already present is never duplicated", () => {
  const cookie = "deplo.session_token=a; __Secure-deplo.session_token=b";
  const out = authRequestHeaders(null, cookie);
  assert.equal(out.get("cookie"), cookie);
});

test("cookies that are not Better Auth's are left exactly as they are", () => {
  // `deplo_team` and `theme` are deplo's own and are read by their one name;
  // twinning them would be noise in every request.
  const out = authRequestHeaders(null, "deplo_team=team_a; theme=dark");
  assert.equal(out.get("cookie"), "deplo_team=team_a; theme=dark");
});
