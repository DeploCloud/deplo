import { test } from "node:test";
import assert from "node:assert/strict";

import { blueprintWantsTls, domainScheme } from "./domains";

/**
 * No certificate is ever registered by default — a new domain's provider is
 * `none` unless the user (or a blueprint that expects HTTPS) opts in.
 * `blueprintWantsTls` is the opt-in detector for app creation: it fires only
 * when the blueprint bakes an `https://<one of its own hosts>` URL into an env
 * value, its compose text, or a materialised config file. `domainScheme` is the
 * URL-scheme counterpart every canonical-URL writer uses.
 */

const HOST = "appflowy-keen-puma-01020304.nip.io";
const EXTRA = "web-ui-appflowy-bold-lynx-01020304.nip.io";

test("blueprintWantsTls fires on an https URL to the app's OWN host in env", () => {
  assert.equal(
    blueprintWantsTls([HOST], [`APPFLOWY_BASE_URL=https://${HOST}`]),
    true,
  );
  // Case-insensitive on both sides, and a path after the host still matches.
  assert.equal(
    blueprintWantsTls([HOST.toUpperCase()], [`API=HTTPS://${HOST}/gotrue`]),
    true,
  );
  // Any of the blueprint's hosts counts — an extra host referenced with https
  // opts the whole app in.
  assert.equal(
    blueprintWantsTls([HOST, EXTRA], [`UI=https://${EXTRA}`]),
    true,
  );
});

test("blueprintWantsTls ignores https URLs to FOREIGN hosts (compose comments etc.)", () => {
  // A stray https URL that is not one of the app's own hosts never opts the
  // app into certificate issuance.
  assert.equal(
    blueprintWantsTls(
      [HOST],
      [
        "image: stalwartlabs/stalwart:latest # see https://hub.docker.com/r/stalwartlabs",
        "OPENAI_API_BASE_URL=https://api.openai.com",
      ],
    ),
    false,
  );
  // An http (non-TLS) reference to the app's own host is not an HTTPS opt-in.
  assert.equal(blueprintWantsTls([HOST], [`URL=http://${HOST}`]), false);
  // No hosts / no texts / nullish entries ⇒ never TLS.
  assert.equal(blueprintWantsTls([], [`X=https://${HOST}`]), false);
  assert.equal(blueprintWantsTls([HOST], []), false);
  assert.equal(blueprintWantsTls([null, undefined, ""], [null, undefined]), false);
});

test("blueprintWantsTls tolerates a scheme/trailing-slash on the declared host", () => {
  // Template hosts occasionally arrive as pasted URLs; the check anchors on the
  // bare hostname either way.
  assert.equal(
    blueprintWantsTls([`https://${HOST}/`], [`BASE=https://${HOST}`]),
    true,
  );
});

test("domainScheme: http only for the `none` provider, https otherwise (absent ⇒ legacy https)", () => {
  assert.equal(domainScheme({ certProvider: "none" }), "http");
  assert.equal(domainScheme({ certProvider: "letsencrypt" }), "https");
  assert.equal(domainScheme({ certProvider: "cloudflare" }), "https");
  // A pre-field row (absent provider) keeps its long-standing https reading.
  assert.equal(domainScheme({}), "https");
});
