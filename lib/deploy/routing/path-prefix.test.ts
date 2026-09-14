import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { CR } from "./routing-test-helpers";

test("a path prefix appends && PathPrefix to a parenthesised Host group + priority", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.com", port: null, pathPrefix: "/api" }],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(
    labels.some((l) =>
      l.includes(".rule=(Host(`app.com`)) && PathPrefix(`/api`)"),
    ),
  );
  const ruleLine = labels.find((l) => l.includes(".rule="))!;
  const key = ruleLine.slice(
    "traefik.http.routers.".length,
    ruleLine.indexOf(".rule="),
  );
  assert.ok(key.startsWith("deplo-app__3000-path-api-"), `key was ${key}`);
  assert.ok(
    labels.includes(`traefik.http.routers.${key}.priority=${1_000_000 + 4}`),
  );
  assert.ok(!labels.some((l) => l.includes(".stripprefix.")));
  assert.ok(!labels.some((l) => l.includes(".middlewares=")));
});

test("strip prefix emits a stripprefix middleware prepended to the (empty) chain", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "app.com", port: null, pathPrefix: "/api", stripPrefix: true },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const ruleLine = labels.find((l) => l.includes(".rule="))!;
  const key = ruleLine.slice(
    "traefik.http.routers.".length,
    ruleLine.indexOf(".rule="),
  );
  assert.ok(key.endsWith("-strip"), `key was ${key}`);
  assert.ok(
    labels.includes(
      `traefik.http.middlewares.${key}-stripprefix.stripprefix.prefixes=/api`,
    ),
  );
  assert.ok(
    labels.includes(
      `traefik.http.routers.${key}.middlewares=${key}-stripprefix`,
    ),
  );
});

test("strip prefix prepends the strip mw BEFORE user middlewares (order)", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      {
        name: "app.com",
        port: null,
        pathPrefix: "/api",
        stripPrefix: true,
        middlewares: ["auth@file"],
      },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const ruleLine = labels.find((l) => l.includes(".rule="))!;
  const key = ruleLine.slice(
    "traefik.http.routers.".length,
    ruleLine.indexOf(".rule="),
  );
  assert.ok(
    labels.includes(
      `traefik.http.routers.${key}.middlewares=${key}-stripprefix,auth@file`,
    ),
  );
});

test("stripPrefix:true with NO path is a no-op - byte-identical to a bare route", () => {
  const withStrip = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.com", port: null, stripPrefix: true }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const bare = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.deepEqual(withStrip, bare);
});

test("two hosts with the SAME path fold into one parenthesised OR rule", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null, pathPrefix: "/api" },
      { name: "b.com", port: null, pathPrefix: "/api" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.equal(rules.length, 1);
  assert.ok(
    rules[0].includes("(Host(`a.com`) || Host(`b.com`)) && PathPrefix(`/api`)"),
  );
});

test("two hosts with DIFFERENT paths do NOT fold", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null, pathPrefix: "/api" },
      { name: "a.com", port: null, pathPrefix: "/admin" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.equal(rules.length, 2);
});

test("distinct signatures get DISTINCT router keys (no safe()-collapse collision)", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null, pathPrefix: "/api", stripPrefix: true },
      { name: "b.com", port: null, pathPrefix: "/api-strip" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const keys = labels
    .filter((l) => l.includes(".rule="))
    .map((l) => l.slice("traefik.http.routers.".length, l.indexOf(".rule=")));
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("slash-vs-dash paths get DISTINCT keys (no safe()-collapse collision)", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null, pathPrefix: "/a/b" },
      { name: "b.com", port: null, pathPrefix: "/a-b" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const keys = labels
    .filter((l) => l.includes(".rule="))
    .map((l) => l.slice("traefik.http.routers.".length, l.indexOf(".rule=")));
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("a path prefix is re-rendered byte-identically (deterministic key/hash)", () => {
  const make = () =>
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [
        { name: "app.com", port: null, pathPrefix: "/api", stripPrefix: true },
      ],
      defaultPort: 3000,
      certResolver: CR,
    });
  assert.deepEqual(make(), make());
});

test("per-route mode applies PathPrefix + stripprefix too (compose path)", () => {
  const labels = traefikRouterLabels({
    baseKey: "ignored",
    routes: [
      { name: "app.com", port: 8080, pathPrefix: "/api", stripPrefix: true },
      { name: "app.com", port: 3000 },
    ],
    defaultPort: 80,
    certResolver: CR,
    dockerNetwork: "deplo",
    perRouteKey: (r) => `deplo-svc-${r.port}`,
  });
  assert.ok(
    labels.some((l) =>
      l.includes(
        "traefik.http.routers.deplo-svc-8080.rule=(Host(`app.com`)) && PathPrefix(`/api`)",
      ),
    ),
  );
  assert.ok(
    labels.includes(
      "traefik.http.middlewares.deplo-svc-8080-stripprefix.stripprefix.prefixes=/api",
    ),
  );
  assert.ok(
    labels.includes(
      `traefik.http.routers.deplo-svc-8080.priority=${1_000_000 + 4}`,
    ),
  );
  assert.ok(
    labels.includes("traefik.http.routers.deplo-svc-3000.rule=Host(`app.com`)"),
  );
  assert.ok(
    !labels.some((l) =>
      l.startsWith("traefik.http.routers.deplo-svc-3000.priority"),
    ),
  );
  assert.ok(1_000_000 + 4 > "Host(`app.com`)".length);
});
