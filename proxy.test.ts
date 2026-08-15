import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

/**
 * The headers that decide whether the panel is usable at all on the address it
 * answers on WITHOUT any DNS: its server's own `http://<ip>:3000`.
 *
 * Deciding `isHttps` from `DEPLO_PUBLIC_URL` rather than from the request sent
 * `upgrade-insecure-requests` to that plain-http page too, and the W3C algorithm
 * has no carve-out for IP hosts: the navigation is exempt, so the document
 * loads, and every relative stylesheet and chunk under it is promoted to an
 * `https://<ip>:3000` nothing serves. The panel rendered with no CSS and never
 * hydrated - a bug with no error message anywhere, which is why it is pinned
 * here rather than left to a browser to rediscover.
 *
 * The same mistake outlived turning HTTPS off from the panel: that moves the
 * stored address, never the env var, so the header kept being sent afterwards.
 */

const PANEL = "https://deplo.example.com";
const previous = process.env.DEPLO_PUBLIC_URL;

afterEach(() => {
  if (previous === undefined) delete process.env.DEPLO_PUBLIC_URL;
  else process.env.DEPLO_PUBLIC_URL = previous;
});

/** `/login` is public, so the proxy answers with headers instead of a redirect. */
function headersFor(url: string, headers: Record<string, string> = {}) {
  process.env.DEPLO_PUBLIC_URL = PANEL;
  const res = proxy(new NextRequest(new Request(url, { headers })));
  return {
    csp: res.headers.get("content-security-policy") ?? "",
    hsts: res.headers.get("strict-transport-security"),
  };
}

test("the panel's own address, behind a proxy that terminates TLS, is treated as https", () => {
  const { csp, hsts } = headersFor("http://deplo.example.com/login", {
    host: "deplo.example.com",
    "x-forwarded-proto": "https",
  });
  assert.match(csp, /upgrade-insecure-requests/);
  assert.ok(hsts, "an https panel still gets HSTS");
});

test("a request that arrived on plain http gets NEITHER upgrade nor HSTS", () => {
  // The IP address, reached directly: no proxy, no TLS, no x-forwarded-proto.
  const { csp, hsts } = headersFor("http://198.51.100.7:3000/login", {
    host: "198.51.100.7:3000",
  });
  assert.doesNotMatch(
    csp,
    /upgrade-insecure-requests/,
    "upgrading here breaks every stylesheet on the page",
  );
  assert.equal(hsts, null, "HSTS has no business on a plain-http response");
});

test("x-forwarded-proto: http is believed over the configured address", () => {
  // The panel was moved to http from Settings, Deplo. The env var still says
  // https and always will - the setting is stored in the database.
  const { csp, hsts } = headersFor("http://deplo.example.com/login", {
    host: "deplo.example.com",
    "x-forwarded-proto": "http",
  });
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(hsts, null);
});

test("with no proxy header at all, only the configured host counts as https", () => {
  const canonical = headersFor("http://deplo.example.com/login", {
    host: "deplo.example.com",
  });
  assert.match(
    canonical.csp,
    /upgrade-insecure-requests/,
    "an https instance behind a proxy that sets no header keeps its hardening",
  );

  const other = headersFor("http://198.51.100.7:3000/login", {
    host: "198.51.100.7:3000",
  });
  assert.doesNotMatch(other.csp, /upgrade-insecure-requests/);
});

test("HSTS is remembered for months, so it never carries preload or subdomains", () => {
  // Both were traps. `preload` at two years meant turning HTTPS off - the
  // setting that exists to rescue a panel whose address cannot get a
  // certificate - left the hostname unreachable over http for two years, with
  // no way back from inside the panel. `includeSubDomains` reached past the
  // panel onto apps, which are born on the `none` certificate provider.
  const { hsts } = headersFor("http://deplo.example.com/login", {
    host: "deplo.example.com",
    "x-forwarded-proto": "https",
  });
  assert.doesNotMatch(hsts ?? "", /preload/);
  assert.doesNotMatch(hsts ?? "", /includeSubDomains/);
});
