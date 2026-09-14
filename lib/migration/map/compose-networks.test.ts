import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../../yaml";
import { adaptComposeForDeplo } from "./compose-adapt";
import { COOLIFY_PLATFORM } from "./map-test-helpers";

test("adaptComposeForDeplo removes Dokploy's network, declaration and every reference", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "    networks:",
    "      - dokploy-network",
    "      - internal",
    "  worker:",
    "    image: busybox",
    "    networks:",
    "      - dokploy-network",
    "networks:",
    "  dokploy-network:",
    "    external: true",
    "  internal: {}",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  assert.ok(changes.length > 0);
  const doc = yaml.load(compose) as {
    services: Record<string, { networks?: unknown }>;
    networks: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(doc.networks), ["internal"]);
  assert.deepEqual(doc.services.web.networks, ["internal"]);
  // An emptied key goes away entirely rather than leaving `networks: []`, which compose rejects.
  assert.equal("networks" in doc.services.worker, false);
});

test("adaptComposeForDeplo resolves the network by name, not by key", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "    networks:",
    "      shared: {}",
    "networks:",
    "  shared:",
    "    external: true",
    "    name: dokploy-network",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  assert.ok(changes.length > 0);
  const doc = yaml.load(compose) as {
    services: Record<string, { networks?: unknown }>;
    networks?: unknown;
  };
  assert.equal(doc.networks, undefined);
  assert.equal("networks" in doc.services.web, false);
});

test("adaptComposeForDeplo drops a network made on the source host", () => {
  const source = [
    "services:",
    "  app:",
    "    image: nginx",
    "    networks: [shared-net, own]",
    "networks:",
    "  shared-net:",
    "    external: true",
    "  own: {}",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  const doc = yaml.load(compose) as {
    services: Record<string, { networks?: unknown }>;
    networks: Record<string, unknown>;
  };
  // Left in place, compose refuses the whole stack: "declared as external, but could not be found".
  assert.deepEqual(Object.keys(doc.networks), ["own"]);
  assert.deepEqual(doc.services.app.networks, ["own"]);
  assert.ok(
    changes.some((c) => c.startsWith("shared-net lives on the server")),
  );
});

test("adaptComposeForDeplo keeps a network the stack creates itself", () => {
  const source = [
    "services:",
    "  app:",
    "    image: nginx",
    "    networks: [backend]",
    "networks:",
    "  backend:",
    "    driver: bridge",
    "    ipam:",
    "      config:",
    "        - subnet: 172.30.9.0/24",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  const doc = yaml.load(compose) as {
    services: Record<string, { networks?: unknown }>;
    networks: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(doc.networks), ["backend"]);
  assert.deepEqual(doc.services.app.networks, ["backend"]);
  assert.deepEqual(changes, []);
});

test("adaptComposeForDeplo drops a network_mode naming a host network", () => {
  const source = [
    "services:",
    "  app:",
    "    image: nginx",
    "    network_mode: shared-net",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  const doc = yaml.load(compose) as {
    services: Record<string, Record<string, unknown>>;
  };
  // `networks:` stays empty while this is set, so the service would join nothing and resolve nothing.
  assert.equal("network_mode" in doc.services.app, false);
  assert.ok(changes.some((c) => c.includes("network_mode: shared-net")));
});

test("adaptComposeForDeplo leaves the network_mode keywords alone", () => {
  for (const mode of ["host", "none", "bridge", "default", "service:api"]) {
    const source = [
      "services:",
      "  api:",
      "    image: nginx",
      "  app:",
      "    image: nginx",
      `    network_mode: "${mode}"`,
    ].join("\n");
    const { compose } = adaptComposeForDeplo(source);
    const doc = yaml.load(compose) as {
      services: Record<string, { network_mode?: string }>;
    };
    assert.equal(doc.services.app.network_mode, mode, mode);
  }
});

test("adaptComposeForDeplo also reads the nested external.name form", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "networks:",
    "  aliased:",
    "    external:",
    "      name: dokploy-network",
  ].join("\n");
  const { compose, changes } = adaptComposeForDeplo(source);
  assert.ok(changes.length > 0);
  assert.equal(
    (yaml.load(compose) as { networks?: unknown }).networks,
    undefined,
  );
});

test("adaptComposeForDeplo removes a per-resource network pointed at by name", () => {
  const source = [
    "services:",
    "  app:",
    "    image: nginx",
    "networks:",
    "  default:",
    "    name: ewc08w0",
    "    external: true",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source, COOLIFY_PLATFORM);
  assert.ok(changes.some((c) => c.startsWith("Coolify's shared network")));
  const doc = yaml.load(compose) as { networks?: Record<string, unknown> };
  assert.equal(doc.networks, undefined);
});

test("adaptComposeForDeplo removes a per-resource network named by its key", () => {
  const source = [
    "services:",
    "  app:",
    "    image: nginx",
    "    networks:",
    "      - ewc08w0",
    "networks:",
    "  ewc08w0:",
    "    external: true",
  ].join("\n");

  const { compose } = adaptComposeForDeplo(source, COOLIFY_PLATFORM);
  const doc = yaml.load(compose) as {
    services: Record<string, { networks?: unknown }>;
    networks?: Record<string, unknown>;
  };
  assert.equal(doc.networks, undefined);
  assert.equal("networks" in doc.services.app, false);
});

// A network the stack declares itself is the stack's, whatever it is called; only Dokploy's fixed name speaks for itself without `external:`.
test("adaptComposeForDeplo keeps an internal network that merely shares the name", () => {
  const source = [
    "services:",
    "  app:",
    "    image: nginx",
    "    networks:",
    "      - coolify",
    "networks:",
    "  coolify:",
    "    driver: bridge",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source, COOLIFY_PLATFORM);
  assert.deepEqual(changes, []);
  const doc = yaml.load(compose) as { networks: Record<string, unknown> };
  assert.deepEqual(Object.keys(doc.networks), ["coolify"]);
});

test("adaptComposeForDeplo names the platform in its own words", () => {
  const source = [
    "services:",
    "  app:",
    "    image: nginx",
    "networks:",
    "  dokploy-network:",
    "    external: true",
  ].join("\n");

  const { changes } = adaptComposeForDeplo(source);
  assert.ok(changes.some((c) => c.startsWith("Dokploy's shared network")));
});
