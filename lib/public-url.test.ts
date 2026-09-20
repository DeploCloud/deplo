import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  requestOrigin,
  cookiesAreSecure,
  passkeyRelyingParty,
  publicBaseUrl,
  requestIsHttps,
  setStoredPublicBaseUrl,
} from "./public-url";

const ENV = process.env.DEPLO_PUBLIC_URL;

afterEach(() => {
  setStoredPublicBaseUrl(null);
  if (ENV === undefined) delete process.env.DEPLO_PUBLIC_URL;
  else process.env.DEPLO_PUBLIC_URL = ENV;
});

test("the stored address wins over the one the box was installed with", () => {
  process.env.DEPLO_PUBLIC_URL = "https://installed.example.com";
  assert.equal(publicBaseUrl(), "https://installed.example.com");
  assert.equal(cookiesAreSecure(), true);

  setStoredPublicBaseUrl("http://moved.example.com");
  assert.equal(publicBaseUrl(), "http://moved.example.com");
  assert.equal(cookiesAreSecure(), false);

  setStoredPublicBaseUrl("https://moved.example.com");
  assert.equal(cookiesAreSecure(), true);
});

test("clearing the stored address hands the answer back to the environment", () => {
  process.env.DEPLO_PUBLIC_URL = "https://installed.example.com";
  setStoredPublicBaseUrl("http://moved.example.com");
  setStoredPublicBaseUrl(null);
  assert.equal(publicBaseUrl(), "https://installed.example.com");
  assert.equal(cookiesAreSecure(), true);
});

test("the request's own origin is read off the headers, proxy first", () => {
  assert.equal(
    requestOrigin(
      new Headers({
        host: "deplo:3000",
        "x-forwarded-host": "deplo.example.com",
        "x-forwarded-proto": "http",
      }),
    ),
    "http://deplo.example.com",
  );
  assert.equal(requestOrigin(new Headers({ host: "not a host" })), null);
  assert.equal(requestOrigin(new Headers()), null);
});

test("a trailing slash never changes the answer", () => {
  setStoredPublicBaseUrl("https://moved.example.com/");
  assert.equal(publicBaseUrl(), "https://moved.example.com");
  assert.equal(cookiesAreSecure(), true);
});

test("knowing no address at all is not a reason to mark cookies Secure", () => {
  delete process.env.DEPLO_PUBLIC_URL;
  assert.equal(publicBaseUrl(), null);
  assert.equal(cookiesAreSecure(), false);
});

test("the relying party is the panel's own hostname, https only", () => {
  setStoredPublicBaseUrl("https://deplo.example.com");
  assert.deepEqual(passkeyRelyingParty(), {
    rpId: "deplo.example.com",
    origin: "https://deplo.example.com",
  });

  setStoredPublicBaseUrl("https://deplo.example.com:8443");
  assert.deepEqual(passkeyRelyingParty(), {
    rpId: "deplo.example.com",
    origin: "https://deplo.example.com:8443",
  });
});

test("plain http has no relying party, except on localhost", () => {
  setStoredPublicBaseUrl("http://198.51.100.7:3000");
  assert.equal(passkeyRelyingParty(), null);

  setStoredPublicBaseUrl("http://localhost:3000");
  assert.deepEqual(passkeyRelyingParty(), {
    rpId: "localhost",
    origin: "http://localhost:3000",
  });

  setStoredPublicBaseUrl("http://127.0.0.1:3000");
  assert.deepEqual(passkeyRelyingParty(), {
    rpId: "127.0.0.1",
    origin: "http://127.0.0.1:3000",
  });
});

test("no address, and nothing to bind a passkey to", () => {
  delete process.env.DEPLO_PUBLIC_URL;
  assert.equal(passkeyRelyingParty(), null);
});

test("with no request to read, the instance's own answer stands", async () => {
  setStoredPublicBaseUrl("https://deplo.example.com");
  assert.equal(await requestIsHttps(), true);

  setStoredPublicBaseUrl("http://198.51.100.7:3000");
  assert.equal(await requestIsHttps(), false);
});

test("the stored address is shared across module registries", () => {
  const slot = Symbol.for("deplo.public-url.stored");
  const shared = globalThis as unknown as Record<symbol, unknown>;
  process.env.DEPLO_PUBLIC_URL = "https://deplo-c6336407.deplo.site";

  setStoredPublicBaseUrl("https://panel.example.com/");
  assert.equal(shared[slot], "https://panel.example.com");

  shared[slot] = "https://panel.example.com";
  assert.equal(publicBaseUrl(), "https://panel.example.com");
  assert.deepEqual(passkeyRelyingParty(), {
    rpId: "panel.example.com",
    origin: "https://panel.example.com",
  });
});
