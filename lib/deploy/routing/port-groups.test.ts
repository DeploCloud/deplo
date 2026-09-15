import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { CR } from "./routing-test-helpers";

test("single-image: one host, default port - no docker.network, no explicit service", () => {
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

test("single-image: two domains, same port - one router, OR rule", () => {
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

test("single-image: per-domain port override - two routers, __ separator, explicit service", () => {
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

test("single-image: only an override, no default-port group - still gets __ suffix", () => {
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

test("single-image: three ports - default first, then ascending; deterministic", () => {
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
  const ruleOrder = labels.filter((l) => l.includes(".rule="));
  assert.deepEqual(ruleOrder, [
    "traefik.http.routers.deplo-app.rule=Host(`a.com`)",
    "traefik.http.routers.deplo-app__8080.rule=Host(`c.com`)",
    "traefik.http.routers.deplo-app__9000.rule=Host(`b.com`)",
  ]);
});

test("__ separator keeps a non-default port group from colliding with a sibling slug", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "api.com", port: 8080 }],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(
    labels.some((l) => l.startsWith("traefik.http.routers.deplo-app__8080.")),
  );
  assert.ok(
    !labels.some((l) => l.startsWith("traefik.http.routers.deplo-app-8080.")),
  );
});

test("non-default ports sort NUMERICALLY (:80 before :100), not as strings", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null },
      { name: "b.com", port: 100 },
      { name: "c.com", port: 80 },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.deepEqual(rules, [
    "traefik.http.routers.deplo-app.rule=Host(`a.com`)",
    "traefik.http.routers.deplo-app__80.rule=Host(`c.com`)",
    "traefik.http.routers.deplo-app__100.rule=Host(`b.com`)",
  ]);
});

test("single-image: explicit port == defaultPort renders byte-identically to null", () => {
  const nullPort = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const explicitPort = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: 3000 }],
    certResolver: CR,
    defaultPort: 3000,
  });
  assert.deepEqual(explicitPort, nullPort);
});

test("single-image: mixed null + explicit-default ports still fold into ONE router", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.example.com", port: null },
      { name: "b.example.com", port: 3000 },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app.rule=Host(`a.example.com`) || Host(`b.example.com`)",
    ),
  );
  assert.ok(
    labels.includes(
      "traefik.http.services.deplo-app.loadbalancer.server.port=3000",
    ),
  );
  assert.ok(!labels.some((l) => l.includes("deplo-app__3000")));
});
