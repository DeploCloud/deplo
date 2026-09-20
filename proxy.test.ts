import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

const PANEL = "https://deplo.example.com";
const previous = process.env.DEPLO_PUBLIC_URL;

afterEach(() => {
  if (previous === undefined) delete process.env.DEPLO_PUBLIC_URL;
  else process.env.DEPLO_PUBLIC_URL = previous;
});

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

test("a page served over http may still ask the panel's own https address", () => {
  const { csp } = headersFor("http://deplo.example.com/login", {
    host: "deplo.example.com",
    "x-forwarded-proto": "http",
  });
  assert.match(csp, /connect-src 'self' https:\/\/deplo\.example\.com(;|$)/);
});

test("the generated host gets no HSTS, so its certificate warning stays skippable", () => {
  const { csp, hsts } = headersFor("https://deplo-cb007109.deplo.site/login", {
    host: "deplo-cb007109.deplo.site",
    "x-forwarded-proto": "https",
  });
  assert.equal(hsts, null);
  assert.match(csp, /upgrade-insecure-requests/, "still an https page");
});

test("HSTS is remembered for months, so it never carries preload or subdomains", () => {
  const { hsts } = headersFor("http://deplo.example.com/login", {
    host: "deplo.example.com",
    "x-forwarded-proto": "https",
  });
  assert.doesNotMatch(hsts ?? "", /preload/);
  assert.doesNotMatch(hsts ?? "", /includeSubDomains/);
});
