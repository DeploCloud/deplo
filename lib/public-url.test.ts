import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { cookiesAreSecure, publicBaseUrl, setStoredPublicBaseUrl } from "./public-url";

/**
 * One predicate decides whether EVERY cookie Deplo writes may be `Secure`, and
 * both ways of getting it wrong are silent:
 *
 *  - Secure on an http panel: the browser drops the cookie without a word. The
 *    session one means nobody can log in; `deplo_team` means everyone is logged
 *    in with no active team, which resolves nothing. Both read as "the panel is
 *    broken" and neither says why.
 *  - Not secure on an https panel: the session cookie travels in clear on any
 *    downgraded request.
 *
 * So what it reads is the point: the address the panel answers on NOW, which an
 * operator can change from the panel itself, not the env var the box booted with.
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
  // Fails to the setting that still WORKS: a Secure cookie on a panel whose
  // scheme we cannot name would be dropped on http and lock everyone out. The
  // https panel that lands here has no configured address either, which is a
  // louder problem than this one.
  assert.equal(cookiesAreSecure(), false);
});
