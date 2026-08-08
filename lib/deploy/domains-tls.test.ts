import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blueprintWantsTls,
  certResolver,
  domainScheme,
  domainTlsConfig,
} from "./domains";

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

test("domainScheme: the `custom` provider is https - it is a certificate, just not ours", () => {
  assert.equal(domainScheme({ certProvider: "custom" }), "https");
});

/**
 * The `custom` provider is the domain-side half of "bring your own certificate":
 * the operator installed one on the SERVER (Settings, Servers, Certificates) and
 * this is how a hostname asks to be served with it. It is TLS with NO resolver -
 * naming one would have Traefik try to issue a certificate for a domain whose
 * whole point is that it already has one, typically a name no HTTP challenge can
 * reach. Without this provider the only way to get a domain onto :443 was to
 * claim Let's Encrypt issues it, which is both untrue and capped per team.
 */
test("domainTlsConfig: `custom` is HTTPS on websecure with no cert resolver", () => {
  assert.deepEqual(domainTlsConfig({ certProvider: "custom" }), {
    entrypoint: "websecure",
    tls: true,
    certResolver: "",
  });
  // The manual entrypoint override still applies, exactly as it does for the
  // providers that issue.
  assert.deepEqual(domainTlsConfig({ certProvider: "custom", entrypoint: "web" }), {
    entrypoint: "web",
    tls: true,
    certResolver: "",
  });
});

test("domainTlsConfig: every other provider still names a resolver", () => {
  assert.equal(domainTlsConfig({ certProvider: "letsencrypt" }).certResolver, certResolver());
  assert.notEqual(domainTlsConfig({ certProvider: "cloudflare" }).certResolver, "");
  assert.deepEqual(domainTlsConfig({ certProvider: "none" }), {
    entrypoint: "web",
    tls: false,
    certResolver: "",
  });
});
