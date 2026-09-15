import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { CR } from "./routing-test-helpers";

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

test("pinned-network flavour: single router on its own host, network pinned, service explicit", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-aux-app",
      routes: [{ name: "aux-app.1.2.3.4.sslip.io", port: null }],
      defaultPort: 3000,
      certResolver: CR,
      dockerNetwork: "deplo",
      alwaysService: true,
    }),
    [
      "traefik.enable=true",
      "traefik.docker.network=deplo",
      "traefik.http.routers.deplo-aux-app.rule=Host(`aux-app.1.2.3.4.sslip.io`)",
      "traefik.http.routers.deplo-aux-app.entrypoints=websecure",
      "traefik.http.routers.deplo-aux-app.tls=true",
      "traefik.http.routers.deplo-aux-app.tls.certresolver=letsencrypt",
      "traefik.http.routers.deplo-aux-app.service=deplo-aux-app",
      "traefik.http.services.deplo-aux-app.loadbalancer.server.port=3000",
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
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-svc-8080.service=deplo-svc-8080",
    ),
  );
});

test("no routes ⇒ traefik.enable=false and NOTHING else (single-image)", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.deepEqual(labels, ["traefik.enable=false"]);
});

test("no routes ⇒ no router/rule labels even with dockerNetwork / alwaysService set", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [],
    defaultPort: 3000,
    certResolver: CR,
    dockerNetwork: "deplo",
    alwaysService: true,
  });
  assert.deepEqual(labels, ["traefik.enable=false"]);
  assert.ok(!labels.some((l) => l.includes(".rule=")));
  assert.ok(!labels.includes("traefik.enable=true"));
});
