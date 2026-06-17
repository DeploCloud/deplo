import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "./routing";

const CR = "letsencrypt";

// --- The three live call-site flavours, asserted byte-for-byte against the
// output each generator produced before consolidation (the golden baseline). ---

test("single-image: one host, default port — no docker.network, no explicit service", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [{ name: "app.1.2.3.4.sslip.io", port: null }],
      defaultPort: 3000,
      certResolver: CR,
    }),
    [
      "traefik.enable=true",
      "traefik.http.routers.deplo-app.rule=Host(`app.1.2.3.4.sslip.io`)",
      "traefik.http.routers.deplo-app.entrypoints=websecure",
      "traefik.http.routers.deplo-app.tls=true",
      "traefik.http.routers.deplo-app.tls.certresolver=letsencrypt",
      "traefik.http.services.deplo-app.loadbalancer.server.port=3000",
    ],
  );
});

test("single-image: two domains, same port — one router, OR rule", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [
        { name: "a.example.com", port: null },
        { name: "b.example.com", port: null },
      ],
      defaultPort: 3000,
      certResolver: CR,
    }),
    [
      "traefik.enable=true",
      "traefik.http.routers.deplo-app.rule=Host(`a.example.com`) || Host(`b.example.com`)",
      "traefik.http.routers.deplo-app.entrypoints=websecure",
      "traefik.http.routers.deplo-app.tls=true",
      "traefik.http.routers.deplo-app.tls.certresolver=letsencrypt",
      "traefik.http.services.deplo-app.loadbalancer.server.port=3000",
    ],
  );
});

test("single-image: per-domain port override — two routers, __ separator, explicit service", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [
        { name: "a.example.com", port: null },
        { name: "api.example.com", port: 8080 },
      ],
      defaultPort: 3000,
      certResolver: CR,
    }),
    [
      "traefik.enable=true",
      "traefik.http.routers.deplo-app.rule=Host(`a.example.com`)",
      "traefik.http.routers.deplo-app.entrypoints=websecure",
      "traefik.http.routers.deplo-app.tls=true",
      "traefik.http.routers.deplo-app.tls.certresolver=letsencrypt",
      "traefik.http.routers.deplo-app.service=deplo-app",
      "traefik.http.services.deplo-app.loadbalancer.server.port=3000",
      "traefik.http.routers.deplo-app__8080.rule=Host(`api.example.com`)",
      "traefik.http.routers.deplo-app__8080.entrypoints=websecure",
      "traefik.http.routers.deplo-app__8080.tls=true",
      "traefik.http.routers.deplo-app__8080.tls.certresolver=letsencrypt",
      "traefik.http.routers.deplo-app__8080.service=deplo-app__8080",
      "traefik.http.services.deplo-app__8080.loadbalancer.server.port=8080",
    ],
  );
});

test("single-image: only an override, no default-port group — still gets __ suffix", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [{ name: "api.example.com", port: 8080 }],
      defaultPort: 3000,
      certResolver: CR,
    }),
    [
      "traefik.enable=true",
      "traefik.http.routers.deplo-app__8080.rule=Host(`api.example.com`)",
      "traefik.http.routers.deplo-app__8080.entrypoints=websecure",
      "traefik.http.routers.deplo-app__8080.tls=true",
      "traefik.http.routers.deplo-app__8080.tls.certresolver=letsencrypt",
      "traefik.http.services.deplo-app__8080.loadbalancer.server.port=8080",
    ],
  );
});

test("single-image: three ports — default first, then ascending; deterministic", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null },
      { name: "b.com", port: 9000 },
      { name: "c.com", port: 8080 },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  // Default-port (3000) router first, then 8080, then 9000.
  const ruleOrder = labels.filter((l) => l.includes(".rule="));
  assert.deepEqual(ruleOrder, [
    "traefik.http.routers.deplo-app.rule=Host(`a.com`)",
    "traefik.http.routers.deplo-app__8080.rule=Host(`c.com`)",
    "traefik.http.routers.deplo-app__9000.rule=Host(`b.com`)",
  ]);
});

test("compose-stack flavour: docker.network pinned, service always explicit", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [{ name: "app.1.2.3.4.sslip.io", port: null }],
      defaultPort: 80,
      certResolver: CR,
      dockerNetwork: "deplo",
      alwaysService: true,
    }),
    [
      "traefik.enable=true",
      "traefik.docker.network=deplo",
      "traefik.http.routers.deplo-app.rule=Host(`app.1.2.3.4.sslip.io`)",
      "traefik.http.routers.deplo-app.entrypoints=websecure",
      "traefik.http.routers.deplo-app.tls=true",
      "traefik.http.routers.deplo-app.tls.certresolver=letsencrypt",
      "traefik.http.routers.deplo-app.service=deplo-app",
      "traefik.http.services.deplo-app.loadbalancer.server.port=80",
    ],
  );
});

test("dev-preview flavour: single router on its own host, network pinned, service explicit", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-dev-app",
      routes: [{ name: "dev-app.1.2.3.4.sslip.io", port: null }],
      defaultPort: 3000,
      certResolver: CR,
      dockerNetwork: "deplo",
      alwaysService: true,
    }),
    [
      "traefik.enable=true",
      "traefik.docker.network=deplo",
      "traefik.http.routers.deplo-dev-app.rule=Host(`dev-app.1.2.3.4.sslip.io`)",
      "traefik.http.routers.deplo-dev-app.entrypoints=websecure",
      "traefik.http.routers.deplo-dev-app.tls=true",
      "traefik.http.routers.deplo-dev-app.tls.certresolver=letsencrypt",
      "traefik.http.routers.deplo-dev-app.service=deplo-dev-app",
      "traefik.http.services.deplo-dev-app.loadbalancer.server.port=3000",
    ],
  );
});

test("per-route mode: one router per route in input order (compose multi-service)", () => {
  const labels = traefikRouterLabels({
    baseKey: "ignored",
    routes: [
      { name: "ui.example.com", port: 8080 },
      { name: "api.example.com", port: 9000 },
    ],
    defaultPort: 80,
    certResolver: CR,
    dockerNetwork: "deplo",
    perRouteKey: (r) => `deplo-svc-${r.port}`,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.deepEqual(rules, [
    "traefik.http.routers.deplo-svc-8080.rule=Host(`ui.example.com`)",
    "traefik.http.routers.deplo-svc-9000.rule=Host(`api.example.com`)",
  ]);
  // per-route mode always names the service.
  assert.ok(labels.includes("traefik.http.routers.deplo-svc-8080.service=deplo-svc-8080"));
});

test("custom cert resolver propagates", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "x.com", port: null }],
    defaultPort: 80,
    certResolver: "letsencrypt-http",
  });
  assert.ok(
    labels.includes("traefik.http.routers.deplo-app.tls.certresolver=letsencrypt-http"),
  );
});

test("__ separator keeps a non-default port group from colliding with a sibling slug", () => {
  // A project slug can be literally `app-8080`; a `-`-only suffix on `deplo-app`
  // for port 8080 would byte-collide with `deplo-app-8080`. The `__` separator
  // can't appear in a slug, so the keys stay distinct.
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "api.com", port: 8080 }],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(labels.some((l) => l.startsWith("traefik.http.routers.deplo-app__8080.")));
  assert.ok(!labels.some((l) => l.startsWith("traefik.http.routers.deplo-app-8080.")));
});
