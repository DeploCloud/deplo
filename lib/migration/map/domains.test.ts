import { test } from "node:test";
import assert from "node:assert/strict";

import { isThrowawayHost, mapDomains } from "./domains";

test("isThrowawayHost only matches the generated hosts", () => {
  for (const host of [
    "app-abc.traefik.me",
    "1.2.3.4.sslip.io",
    "x.nip.io",
    "api.localhost",
  ])
    assert.equal(isThrowawayHost(host), true, host);
  for (const host of ["acme.com", "api.acme.com", "traefik.mecca.com"])
    assert.equal(isThrowawayHost(host), false, host);
});

test("mapDomains keeps every host in order and drops only what cannot route", () => {
  const { value } = mapDomains(
    [
      {
        domainId: "1",
        host: "app-x.traefik.me",
        certificateType: "letsencrypt",
      },
      {
        domainId: "2",
        host: "Acme.com",
        port: 8080,
        certificateType: "letsencrypt",
      },
      { domainId: "3", host: "old.acme.com", enabled: false },
      { domainId: "4", host: "pr.acme.com", domainType: "preview" },
      {
        domainId: "5",
        host: "api.acme.com",
        path: "/api",
        stripPath: true,
        port: 3000,
      },
    ],
    { isCompose: false },
  );
  assert.deepEqual(
    value.map((d) => d.host),
    ["app-x.traefik.me", "acme.com", "api.acme.com"],
  );
  assert.deepEqual(
    value.map((d) => d.generated),
    [true, false, false],
  );
  assert.equal(value[1].port, 8080);
  assert.equal(value[1].certProvider, "letsencrypt");
  assert.equal(value[2].pathPrefix, "/api");
  assert.equal(value[2].stripPrefix, true);
});

test("mapDomains keeps a throwaway host's whole route", () => {
  const { value } = mapDomains(
    [
      {
        domainId: "1",
        host: "myapp-abc.sslip.io",
        port: 8080,
        path: "/api",
        stripPath: true,
        serviceName: "api",
        https: false,
      },
    ],
    { isCompose: true },
  );
  assert.deepEqual(value, [
    {
      host: "myapp-abc.sslip.io",
      port: 8080,
      pathPrefix: "/api",
      stripPrefix: true,
      certProvider: "none",
      entrypoint: "web",
      service: "api",
      generated: true,
    },
  ]);
});

test("mapDomains reports a custom certificate resolver it cannot carry", () => {
  const { value, notes } = mapDomains(
    [{ domainId: "1", host: "acme.com", certificateType: "custom" }],
    { isCompose: false },
  );
  assert.equal(value[0].certProvider, "none");
  assert.match(notes.join(" "), /custom certificate resolver/);
});

test("mapDomains keeps the compose service and needs a port there", () => {
  const { value, notes } = mapDomains(
    [{ domainId: "1", host: "acme.com", serviceName: "web" }],
    { isCompose: true },
  );
  assert.equal(value[0].service, "web");
  assert.match(notes.join(" "), /needs one for a compose stack/);
});

test("mapDomains says which routes lose their own entrypoint", () => {
  const { value, notes } = mapDomains(
    [
      {
        domainId: "d1",
        host: "mail.acme.test",
        customEntrypoint: "smtp",
        port: 25,
      },
      { domainId: "d2", host: "acme.test", customEntrypoint: "websecure" },
    ],
    { isCompose: false },
  );
  assert.equal(value.length, 2);
  assert.match(notes.join(" "), /"smtp"/);
  assert.equal(
    notes.length,
    1,
    "one of Deplo's own entrypoints is not a loss to report",
  );
});

test("mapDomains routes plain http to the web entrypoint", () => {
  const { value } = mapDomains(
    [
      {
        domainId: "1",
        host: "acme.com",
        https: false,
        certificateType: "none",
      },
    ],
    { isCompose: false },
  );
  assert.equal(value[0].entrypoint, "web");
});

test("mapDomains reports a real internal-path rewrite and ignores the default", () => {
  const withRewrite = mapDomains(
    [
      {
        domainId: "d1",
        host: "shop.example.com",
        path: "/shop",
        internalPath: "/",
      },
      {
        domainId: "d2",
        host: "api.example.com",
        path: "/v2",
        internalPath: "/internal",
      },
    ],
    { isCompose: false },
  );
  const joined = withRewrite.notes.join(" ");
  assert.doesNotMatch(joined, /shop\.example\.com rewrites/);
  assert.match(joined, /api\.example\.com rewrites the path to \/internal/);
  assert.equal(withRewrite.value.length, 2);
  assert.equal(withRewrite.value[0].pathPrefix, "/shop");
});

test("a domain with no port of its own routes to the port the app listens on", () => {
  const domains = [
    { domainId: "d1", host: "web.acme.com", https: true },
    { domainId: "d2", host: "api.acme.com", https: true, port: 9000 },
  ];
  assert.deepEqual(
    mapDomains(domains, { isCompose: false, fallbackPort: 5006 }).value.map(
      (d) => d.port,
    ),
    [5006, 9000],
  );
});

test("a compose route with no port reads it off the service it names", () => {
  const compose = [
    "services:",
    "  vaultwarden:",
    "    image: vaultwarden/server",
    "  db:",
    "    image: postgres:16",
  ].join("\n");
  const { value, notes } = mapDomains(
    [
      {
        domainId: "d1",
        host: "vault.acme.test",
        serviceName: "vaultwarden",
        port: null,
        certificateType: "letsencrypt",
      },
    ],
    { isCompose: true, compose },
  );
  assert.equal(value[0].port, 80);
  assert.equal(value[0].service, "vaultwarden");
  assert.ok(
    notes.some((n) => /routes it to vaultwarden on port 80/.test(n)),
    notes.join(" | "),
  );
});

test("a port the panel DID record is never second-guessed", () => {
  const { value, notes } = mapDomains(
    [
      {
        domainId: "d1",
        host: "app.acme.test",
        serviceName: "web",
        port: 3000,
        certificateType: "letsencrypt",
      },
    ],
    {
      isCompose: true,
      compose:
        "services:\n  web:\n    image: nginx\n    expose:\n      - 8080\n",
    },
  );
  assert.equal(value[0].port, 3000);
  assert.equal(notes.length, 0);
});
