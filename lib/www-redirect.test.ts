import { test } from "node:test";
import assert from "node:assert/strict";

import { wwwCounterpart, deriveWwwRedirect } from "./www-redirect";

/**
 * The `www` pair rules. Both the data layer (which writes the second domain row)
 * and the domain dialogs (which spell the two hostnames out in their option
 * labels) read them from here, so the option a user picks and the row the server
 * writes can never disagree.
 */

/* ------------------------------------------------------------------ */
/* wwwCounterpart                                                      */
/* ------------------------------------------------------------------ */

test("apex ⇄ www is symmetric", () => {
  assert.equal(wwwCounterpart("example.com"), "www.example.com");
  assert.equal(wwwCounterpart("www.example.com"), "example.com");
});

test("a two-label public suffix still reads as an apex", () => {
  assert.equal(wwwCounterpart("example.co.uk"), "www.example.co.uk");
  assert.equal(wwwCounterpart("www.example.co.uk"), "example.co.uk");
  assert.equal(wwwCounterpart("loja.com.br"), "www.loja.com.br");
});

test("an ordinary subdomain has no www variant to offer", () => {
  // `www.api.example.com` is nobody's site — offering it would be a knob about
  // a hostname that never gets used.
  assert.equal(wwwCounterpart("api.example.com"), null);
  assert.equal(wwwCounterpart("staging.app.example.com"), null);
});

test("stripping a leading www is unambiguous even on a deep host", () => {
  // The `www.` direction is safe wherever it appears: the bare host is a real
  // hostname the user already owns.
  assert.equal(wwwCounterpart("www.api.example.com"), "api.example.com");
});

test("generated zero-config hosts are excluded", () => {
  // nip.io answers ANY label, so `www.<host>.nip.io` would resolve to the same
  // IP under a name nobody asked for.
  assert.equal(wwwCounterpart("app-brave-otter-7f000001.nip.io"), null);
  assert.equal(wwwCounterpart("app.1.2.3.4.sslip.io"), null);
  assert.equal(wwwCounterpart("www.app-x-7f000001.nip.io"), null);
});

test("junk and IP literals yield nothing", () => {
  assert.equal(wwwCounterpart(""), null);
  assert.equal(wwwCounterpart("localhost"), null);
  assert.equal(wwwCounterpart("10.0.0.1"), null);
  assert.equal(wwwCounterpart("example.com/path"), null);
});

test("scheme, case, trailing dot and slash are normalised away", () => {
  assert.equal(wwwCounterpart("HTTPS://Example.COM/"), "www.example.com");
  assert.equal(wwwCounterpart("example.com."), "www.example.com");
});

/* ------------------------------------------------------------------ */
/* deriveWwwRedirect — state is READ from the rows, never stored twice  */
/* ------------------------------------------------------------------ */

test("no counterpart row ⇒ none", () => {
  assert.equal(
    deriveWwwRedirect("example.com", [
      { name: "example.com", redirectTo: null },
    ]),
    "none",
  );
});

test("counterpart pointing here ⇒ toThis", () => {
  assert.equal(
    deriveWwwRedirect("example.com", [
      { name: "example.com", redirectTo: null },
      { name: "www.example.com", redirectTo: "example.com" },
    ]),
    "toThis",
  );
});

test("this row pointing at the counterpart ⇒ toCounterpart", () => {
  assert.equal(
    deriveWwwRedirect("example.com", [
      { name: "example.com", redirectTo: "www.example.com" },
      { name: "www.example.com", redirectTo: null },
    ]),
    "toCounterpart",
  );
  // Read from the www row itself, the same pair reads as "the counterpart
  // redirects here" — the state is always relative to the row being edited.
  assert.equal(
    deriveWwwRedirect("www.example.com", [
      { name: "example.com", redirectTo: "www.example.com" },
      { name: "www.example.com", redirectTo: null },
    ]),
    "toThis",
  );
});

test("a counterpart that merely EXISTS is not a pair", () => {
  // Both hostnames serving the app (two ordinary domains) is a legitimate setup
  // and must not be reported as a redirect that isn't there.
  assert.equal(
    deriveWwwRedirect("example.com", [
      { name: "example.com", redirectTo: null },
      { name: "www.example.com", redirectTo: null },
    ]),
    "none",
  );
});

test("a redirect to an unrelated host is not a www pair", () => {
  assert.equal(
    deriveWwwRedirect("example.com", [
      { name: "example.com", redirectTo: "other.example.org" },
    ]),
    "none",
  );
});

test("a hostname with no counterpart is always none", () => {
  assert.equal(
    deriveWwwRedirect("api.example.com", [
      { name: "api.example.com", redirectTo: null },
      { name: "www.api.example.com", redirectTo: "api.example.com" },
    ]),
    "none",
  );
});
