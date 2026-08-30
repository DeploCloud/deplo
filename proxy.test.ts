// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

/**
 * The headers that decide whether the panel is usable at all on the address it
 * answers on WITHOUT any DNS: its server's own `http://<ip>:3000`. Deciding
 * `isHttps` from `DEPLO_PUBLIC_URL` rather than from the request sent
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
  // Both were traps.
  const { hsts } = headersFor("http://deplo.example.com/login", {
    host: "deplo.example.com",
    "x-forwarded-proto": "https",
  });
  assert.doesNotMatch(hsts ?? "", /preload/);
  assert.doesNotMatch(hsts ?? "", /includeSubDomains/);
});
