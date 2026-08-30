// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  cookiesAreSecure,
  passkeyRelyingParty,
  publicBaseUrl,
  requestIsHttps,
  setStoredPublicBaseUrl,
} from "./public-url";

/**
 * One predicate decides whether EVERY cookie Deplo writes may be `Secure`, and
 * both ways of getting it wrong are silent: - Secure on an http panel: the browser
 * drops the cookie without a word.
 */

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

  // The operator turned HTTPS off in the panel. Every cookie written from this
  // moment has to follow, or the panel loads and cannot be logged into.
  setStoredPublicBaseUrl("http://moved.example.com");
  assert.equal(publicBaseUrl(), "http://moved.example.com");
  assert.equal(cookiesAreSecure(), false);

  // And back.
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

test("a trailing slash never changes the answer", () => {
  setStoredPublicBaseUrl("https://moved.example.com/");
  assert.equal(publicBaseUrl(), "https://moved.example.com");
  assert.equal(cookiesAreSecure(), true);
});

test("knowing no address at all is not a reason to mark cookies Secure", () => {
  delete process.env.DEPLO_PUBLIC_URL;
  assert.equal(publicBaseUrl(), null);
  // Fails to the setting that still WORKS: a Secure cookie on a panel whose scheme we
  // cannot name would be dropped on http and lock everyone out.
  assert.equal(cookiesAreSecure(), false);
});

/* ------------------------------------------------------------------ */
/* The WebAuthn relying party                                          */
/* ------------------------------------------------------------------ */

/**
 * A passkey is welded to whatever this returns, so a wrong answer is not a bug
 * that shows up as an error - it is credentials that register fine and then
 * refuse to sign anyone in, from inside the browser, with nothing on the wire.
 */

test("the relying party is the panel's own hostname, https only", () => {
  setStoredPublicBaseUrl("https://deplo.example.com");
  assert.deepEqual(passkeyRelyingParty(), {
    rpId: "deplo.example.com",
    // The ORIGIN, so it compares against clientDataJSON: no path, no slash.
    origin: "https://deplo.example.com",
  });

  // A port is part of the origin but never part of the rpID - WebAuthn scopes a
  // credential to a domain, not to a socket.
  setStoredPublicBaseUrl("https://deplo.example.com:8443");
  assert.deepEqual(passkeyRelyingParty(), {
    rpId: "deplo.example.com",
    origin: "https://deplo.example.com:8443",
  });
});

test("plain http has no relying party, except on localhost", () => {
  // The browser's rule, not deplo's: WebAuthn needs a secure context, and every
  // browser grants loopback the one exception so local development works.
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

/**
 * The per-request answer, which is what the panel's second address depends on.
 * Getting THAT wrong would flip every cookie write that happens off a request, so
 * it is pinned.
 */
test("with no request to read, the instance's own answer stands", async () => {
  setStoredPublicBaseUrl("https://deplo.example.com");
  assert.equal(await requestIsHttps(), true);

  setStoredPublicBaseUrl("http://198.51.100.7:3000");
  assert.equal(await requestIsHttps(), false);
});
