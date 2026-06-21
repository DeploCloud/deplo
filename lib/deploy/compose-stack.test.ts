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

/**
 * Backfill byte-identity contract (the load-bearing guarantee behind making
 * auto/extra domains carry an explicit service+port): a stored domainRoute that
 * merely RESTATES its host's default expose (same service, same port, no path)
 * must render byte-identically to a stack with no such route — otherwise every
 * existing compose deploy would re-render with split per-host routers on its
 * next reroute. Only a route that genuinely diverges becomes a per-host router.
 */
const WEB_COMPOSE = `
services:
  web:
    image: nginx
    ports:
      - "80:80"
`;

function buildRaw(compose: string, extra: Partial<ComposeStackInput> = {}): string {
  return buildComposeStack({
    compose,
    name: "deplo-demo",
    slug: "demo",
    projectId: "p1",
    domains: ["demo.1.2.3.4.sslip.io"],
    expose: { service: "web", port: 80 },
    ...extra,
  });
}

test("a domainRoute restating the default expose renders byte-identically to none", () => {
  const bare = buildRaw(WEB_COMPOSE);
  const backfilled = buildRaw(WEB_COMPOSE, {
    domainRoutes: [
      {
        name: "demo.1.2.3.4.sslip.io",
        service: "web", // == default expose service
        port: 80, // == default expose port
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  assert.equal(backfilled, bare);
});

test("a domainRoute with the default port but no service still renders byte-identically", () => {
  const bare = buildRaw(WEB_COMPOSE);
  const backfilled = buildRaw(WEB_COMPOSE, {
    domainRoutes: [
      {
        name: "demo.1.2.3.4.sslip.io",
        service: null,
        port: 80, // == default expose port
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  assert.equal(backfilled, bare);
});

test("a domainRoute targeting a DIFFERENT service still becomes its own router", () => {
  const compose = `
services:
  web:
    image: nginx
    ports:
      - "80:80"
  api:
    image: api
    ports:
      - "8080:8080"
`;
  const bare = buildRaw(compose);
  const overridden = buildRaw(compose, {
    domains: ["demo.1.2.3.4.sslip.io", "api.example.com"],
    domainRoutes: [
      {
        name: "api.example.com",
        service: "api", // diverges from the default `web` expose
        port: 8080,
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  // The divergent route must change the output (a real per-host router on api).
  assert.notEqual(overridden, bare);
  assert.match(overridden, /api\.example\.com/);
});

test("an extra exposes host backfilled with its own service+port stays byte-identical", () => {
  const compose = `
services:
  web:
    image: nginx
    ports:
      - "80:80"
  ui:
    image: ui
    ports:
      - "3000:3000"
`;
  const exposes = [
    { service: "web", port: 80, host: "demo.1.2.3.4.sslip.io" },
    { service: "ui", port: 3000, host: "ui.example.com" },
  ];
  const domains = ["demo.1.2.3.4.sslip.io", "ui.example.com"];
  const bare = buildRaw(compose, { domains, exposes });
  const backfilled = buildRaw(compose, {
    domains,
    exposes,
    domainRoutes: [
      // Both rows restate their host's pinned exposes entry — pure backfill.
      { name: "demo.1.2.3.4.sslip.io", service: "web", port: 80, pathPrefix: "", stripPrefix: false },
      { name: "ui.example.com", service: "ui", port: 3000, pathPrefix: "", stripPrefix: false },
    ],
  });
  assert.equal(backfilled, bare);
});

/* ------------------------------------------------------------------ */
/* Project-files `./<x>` bind-mount rewrite                            */
/* ------------------------------------------------------------------ */

/** The volume sources of a service, post-build. */
function volsOf(svc: Svc & { volumes?: unknown }): string[] {
  return Array.isArray(svc.volumes) ? (svc.volumes as string[]) : [];
}

test("`./<x>` sources rewrite to the project's files dir; named/flags preserved", () => {
  const doc = buildDoc(
    `
services:
  app:
    image: nginx
    volumes:
      - ./config.toml:/etc/app/config.toml
      - ./nested/dir:/data:ro
      - appdata:/var/lib/app
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.app as Svc & { volumes?: unknown });
  assert.ok(vols.includes("/srv/stacks/files/demo/config.toml:/etc/app/config.toml"));
  // Nested path + the :ro flag survive the rewrite.
  assert.ok(vols.includes("/srv/stacks/files/demo/nested/dir:/data:ro"));
  // A named volume is untouched.
  assert.ok(vols.includes("appdata:/var/lib/app"));
});

test("a `..` escape source is NOT rewritten (left for the host-bind gate to block)", () => {
  const doc = buildDoc(
    `
services:
  app:
    image: nginx
    volumes:
      - ../sibling/data:/data
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.app as Svc & { volumes?: unknown });
  // Unchanged — the gate (isHostBindSource) is what rejects it, not the rewrite.
  assert.ok(vols.includes("../sibling/data:/data"));
});

test("an absolute host source is NOT rewritten", () => {
  const doc = buildDoc(
    `
services:
  app:
    image: nginx
    volumes:
      - /srv/host/data:/data
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.app as Svc & { volumes?: unknown });
  assert.ok(vols.includes("/srv/host/data:/data"));
});
