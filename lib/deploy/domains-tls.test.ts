import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blueprintWantsTls,
  certResolver,
  domainScheme,
  domainTlsConfig,
} from "./domains";

const HOST = "appflowy-keen-puma-01020304.deplo.site";
const EXTRA = "web-ui-appflowy-bold-lynx-01020304.deplo.site";

test("blueprintWantsTls fires on an https URL to the app's OWN host in env", () => {
  assert.equal(
    blueprintWantsTls([HOST], [`APPFLOWY_BASE_URL=https://${HOST}`]),
    true,
  );
  assert.equal(
    blueprintWantsTls([HOST.toUpperCase()], [`API=HTTPS://${HOST}/gotrue`]),
    true,
  );
  assert.equal(blueprintWantsTls([HOST, EXTRA], [`UI=https://${EXTRA}`]), true);
});

test("blueprintWantsTls ignores https URLs to FOREIGN hosts (compose comments etc.)", () => {
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
  assert.equal(blueprintWantsTls([HOST], [`URL=http://${HOST}`]), false);
  assert.equal(blueprintWantsTls([], [`X=https://${HOST}`]), false);
  assert.equal(blueprintWantsTls([HOST], []), false);
  assert.equal(
    blueprintWantsTls([null, undefined, ""], [null, undefined]),
    false,
  );
});

test("blueprintWantsTls tolerates a scheme/trailing-slash on the declared host", () => {
  assert.equal(
    blueprintWantsTls([`https://${HOST}/`], [`BASE=https://${HOST}`]),
    true,
  );
});

test("domainScheme: http only for the `none` provider, https otherwise (absent ⇒ legacy https)", () => {
  assert.equal(domainScheme({ certProvider: "none" }), "http");
  assert.equal(domainScheme({ certProvider: "letsencrypt" }), "https");
  assert.equal(domainScheme({ certProvider: "cloudflare" }), "https");
  assert.equal(domainScheme({}), "https");
});

test("domainScheme: a proxied host is https even with no certificate of its own", () => {
  assert.equal(domainScheme({ certProvider: "none", proxied: true }), "https");
  assert.equal(domainTlsConfig({ certProvider: "none" }).entrypoint, "web");
});

test("domainScheme: the `custom` provider is https - it is a certificate, just not ours", () => {
  assert.equal(domainScheme({ certProvider: "custom" }), "https");
});

test("domainTlsConfig: `custom` is HTTPS on websecure with no cert resolver", () => {
  assert.deepEqual(domainTlsConfig({ certProvider: "custom" }), {
    entrypoint: "websecure",
    tls: true,
    certResolver: "",
  });
  assert.deepEqual(
    domainTlsConfig({ certProvider: "custom", entrypoint: "web" }),
    {
      entrypoint: "web",
      tls: true,
      certResolver: "",
    },
  );
});

test("domainTlsConfig: every other provider still names a resolver", () => {
  assert.equal(
    domainTlsConfig({ certProvider: "letsencrypt" }).certResolver,
    certResolver(),
  );
  assert.notEqual(
    domainTlsConfig({ certProvider: "cloudflare" }).certResolver,
    "",
  );
  assert.deepEqual(domainTlsConfig({ certProvider: "none" }), {
    entrypoint: "web",
    tls: false,
    certResolver: "",
  });
});
