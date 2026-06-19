import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "js-yaml";

import { buildComposeStack, type ComposeStackInput } from "./compose-stack";

/**
 * Port handling is the contract under test: Deplo fronts the routed service via
 * Traefik labels over the `deplo` network, but it must NOT strip the service's
 * published `ports:`. Host publishing is orthogonal to Traefik routing, so a
 * user who publishes a port (a TCP game server, a database, an admin port) keeps
 * it reachable at that host port AND still gets the routing labels.
 */

type Svc = { ports?: unknown[]; networks?: unknown; labels?: unknown };
type Doc = { services: Record<string, Svc> };

/** Build a stack from compose YAML + overrides and parse the result back. */
function buildDoc(compose: string, extra: Partial<ComposeStackInput> = {}): Doc {
  const out = buildComposeStack({
    compose,
    name: "deplo-demo",
    slug: "demo",
    projectId: "p1",
    domains: ["demo.1.2.3.4.sslip.io"],
    expose: { service: "web", port: 80 },
    ...extra,
  });
  return yaml.load(out) as Doc;
}

/** The flattened label strings of a service (compose list form, post-build). */
function labelsOf(svc: Svc): string[] {
  return Array.isArray(svc.labels) ? (svc.labels as string[]) : [];
}

test("routed service keeps its published port (not stripped)", () => {
  const doc = buildDoc(`
services:
  minecraft:
    image: itzg/minecraft-server:latest
    ports:
      - "25565:25565"
`, { expose: { service: "minecraft", port: 25565 } });
  // The Minecraft regression: the routed port must survive so the game server
  // is reachable at host:25565 (Traefik's HTTP router can't serve raw TCP).
  assert.deepEqual(doc.services.minecraft.ports, ["25565:25565"]);
});

test("multi-port routed service keeps every published port verbatim", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
    ports:
      - "80:80"
      - "9100:9100"
`);
  assert.deepEqual(doc.services.web.ports, ["80:80", "9100:9100"]);
});

test("non-routed sidecar port preserved verbatim", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
  metrics:
    image: prom/prometheus
    ports:
      - "9090:9090"
`);
  assert.deepEqual(doc.services.web.ports, ["8080:80"]);
  assert.deepEqual(doc.services.metrics.ports, ["9090:9090"]);
});

test("Traefik labels + deplo network applied alongside the preserved ports", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
`);
  const labels = labelsOf(doc.services.web);
  // Routing rides the deplo network to the container port — orthogonal to host
  // publishing, so the labels coexist with the kept ports.
  assert.ok(labels.includes("traefik.docker.network=deplo"));
  assert.ok(
    labels.includes("traefik.http.services.deplo-demo.loadbalancer.server.port=80"),
  );
  assert.ok((doc.services.web.networks as string[]).includes("deplo"));
  assert.deepEqual(doc.services.web.ports, ["8080:80"]);
});

test("range / long-form object / udp survive untouched", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
    ports:
      - "80:80"
      - "8000-8010:8000-8010"
      - "53:53/udp"
      - target: 5432
        published: 5432
`);
  assert.deepEqual(doc.services.web.ports, [
    "80:80",
    "8000-8010:8000-8010",
    "53:53/udp",
    { target: 5432, published: 5432 },
  ]);
});

test("container_name stripped on every service (the mutation that IS still applied)", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
    container_name: my-web
    ports:
      - "80:80"
`);
  assert.equal(
    (doc.services.web as { container_name?: string }).container_name,
    undefined,
  );
});
