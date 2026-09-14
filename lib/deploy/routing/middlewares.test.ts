import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { CR } from "./routing-test-helpers";

test("a middleware chain emits an ordered middlewares= label on the default router", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [
        {
          name: "app.com",
          port: null,
          middlewares: ["redirect-https", "auth@file"],
        },
      ],
      defaultPort: 3000,
      certResolver: CR,
    }),
    [
      "traefik.enable=true",
      "traefik.http.routers.deplo-app__3000-mw-redirect-https-auth-file.rule=Host(`app.com`)",
      "traefik.http.routers.deplo-app__3000-mw-redirect-https-auth-file.entrypoints=websecure",
      "traefik.http.routers.deplo-app__3000-mw-redirect-https-auth-file.tls=true",
      "traefik.http.routers.deplo-app__3000-mw-redirect-https-auth-file.tls.certresolver=letsencrypt",
      "traefik.http.routers.deplo-app__3000-mw-redirect-https-auth-file.middlewares=redirect-https,auth@file",
      "traefik.http.services.deplo-app__3000-mw-redirect-https-auth-file.loadbalancer.server.port=3000",
    ],
  );
});

test("an empty / whitespace-only middleware chain emits NO middlewares label (byte-stable)", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.com", port: null, middlewares: ["", "  "] }],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(!labels.some((l) => l.includes(".middlewares=")));
  assert.ok(
    labels.includes("traefik.http.routers.deplo-app.rule=Host(`app.com`)"),
  );
});

test("two hosts with different chains split into separate routers", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null, middlewares: ["mw-a"] },
      { name: "b.com", port: null, middlewares: ["mw-b"] },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const mws = labels.filter((l) => l.includes(".middlewares="));
  assert.deepEqual(mws, [
    "traefik.http.routers.deplo-app__3000-mw-mw-a.middlewares=mw-a",
    "traefik.http.routers.deplo-app__3000-mw-mw-b.middlewares=mw-b",
  ]);
});

test("two hosts with the SAME chain fold into one router", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null, middlewares: ["mw-x"] },
      { name: "b.com", port: null, middlewares: ["mw-x"] },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.deepEqual(rules, [
    "traefik.http.routers.deplo-app__3000-mw-mw-x.rule=Host(`a.com`) || Host(`b.com`)",
  ]);
});

test("chain order is significant: reversed chains do NOT fold together", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null, middlewares: ["one", "two"] },
      { name: "b.com", port: null, middlewares: ["two", "one"] },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.equal(rules.length, 2);
});

test("basicAuth: defines the middleware and prepends it to a single router", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
    basicAuth: { name: "deplo-app-basicauth", users: "alice:$apr1$abc$def" },
  });
  assert.ok(
    labels.includes(
      "traefik.http.middlewares.deplo-app-basicauth.basicauth.users=alice:$$apr1$$abc$$def",
    ),
  );
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app__3000-mw-deplo-app-basicauth.middlewares=deplo-app-basicauth",
    ),
  );
});

test("basicAuth: prepends ahead of an existing user middleware, order preserved", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "app.example.com", port: null, middlewares: ["redirect-https"] },
    ],
    defaultPort: 3000,
    certResolver: CR,
    basicAuth: { name: "deplo-app-basicauth", users: "u:h" },
  });
  assert.ok(
    labels.some((l) =>
      l.endsWith(".middlewares=deplo-app-basicauth,redirect-https"),
    ),
  );
});

test("basicAuth: gates EVERY host across distinct routers (per-route mode)", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.example.com", port: 80 },
      { name: "b.example.com", port: 81 },
    ],
    defaultPort: 80,
    certResolver: CR,
    perRouteKey: (r) => `k-${r.name}`,
    basicAuth: { name: "mw-auth", users: "u:h" },
  });
  assert.ok(
    labels.includes("traefik.http.routers.k-a.example.com.middlewares=mw-auth"),
  );
  assert.ok(
    labels.includes("traefik.http.routers.k-b.example.com.middlewares=mw-auth"),
  );
  assert.ok(
    labels.some((l) =>
      l.startsWith("traefik.http.middlewares.mw-auth.basicauth.users="),
    ),
  );
});

test("basicAuth: absent (and empty users) ⇒ byte-identical to no basic auth", () => {
  const base = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const emptyUsers = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
    basicAuth: { name: "deplo-app-basicauth", users: "" },
  });
  assert.deepEqual(emptyUsers, base);
  assert.ok(!base.some((l) => l.includes("basicauth")));
});
