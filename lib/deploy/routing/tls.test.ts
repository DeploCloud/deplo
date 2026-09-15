import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { CR } from "./routing-test-helpers";

test("custom cert resolver propagates", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "x.com", port: null }],
    defaultPort: 80,
    certResolver: "letsencrypt-http",
  });
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app.tls.certresolver=letsencrypt-http",
    ),
  );
});

test("tls:false serves plain HTTP on the web entrypoint - no tls labels", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [{ name: "plain.example.com", port: null, tls: false }],
      defaultPort: 3000,
      certResolver: CR,
    }),
    [
      "traefik.enable=true",
      "traefik.http.routers.deplo-app__3000-http.rule=Host(`plain.example.com`)",
      "traefik.http.routers.deplo-app__3000-http.entrypoints=web",
      "traefik.http.services.deplo-app__3000-http.loadbalancer.server.port=3000",
    ],
  );
});

test("an HTTPS default route and an HTTP route split into two routers", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "secure.example.com", port: null },
      { name: "plain.example.com", port: null, tls: false },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.deepEqual(rules, [
    "traefik.http.routers.deplo-app.rule=Host(`secure.example.com`)",
    "traefik.http.routers.deplo-app__3000-http.rule=Host(`plain.example.com`)",
  ]);
  assert.ok(labels.includes("traefik.http.routers.deplo-app.tls=true"));
  assert.ok(
    !labels.some((l) =>
      l.startsWith("traefik.http.routers.deplo-app__3000-http.tls"),
    ),
  );
});

test("a per-route cert resolver overriding the default suffixes the resolver", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "le.example.com", port: null },
      { name: "cf.example.com", port: null, certResolver: "cloudflare" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app.tls.certresolver=letsencrypt",
    ),
  );
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app__3000-cloudflare.tls.certresolver=cloudflare",
    ),
  );
});

test("two hosts sharing the same non-default resolver fold into one router", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.example.com", port: null, certResolver: "cloudflare" },
      { name: "b.example.com", port: null, certResolver: "cloudflare" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.deepEqual(rules, [
    "traefik.http.routers.deplo-app__3000-cloudflare.rule=Host(`a.example.com`) || Host(`b.example.com`)",
  ]);
});

test("a resolver matching the default does NOT suffix (byte-stable key)", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      {
        name: "x.example.com",
        port: null,
        certResolver: CR,
        entrypoint: "websecure",
        tls: true,
      },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app.rule=Host(`x.example.com`)",
    ),
  );
  assert.ok(!labels.some((l) => l.includes("deplo-app__")));
});

test("a resolver name with unsafe characters is sanitised in the router key", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "x.example.com", port: null, certResolver: "My Resolver!" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(
    labels.some((l) =>
      l.startsWith("traefik.http.routers.deplo-app__3000-my-resolver."),
    ),
  );
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app__3000-my-resolver.tls.certresolver=My Resolver!",
    ),
  );
});

test("an empty cert resolver emits tls=true and NO certresolver label", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: null, certResolver: "" }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const key = "deplo-app__3000-owncert";
  assert.ok(labels.includes(`traefik.http.routers.${key}.tls=true`));
  assert.ok(
    labels.includes(`traefik.http.routers.${key}.entrypoints=websecure`),
  );
  assert.ok(
    !labels.some((l) => l.includes("certresolver")),
    "a router with no resolver must not name one",
  );
});

test("a no-resolver route gets its own router key, never the default one", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "issued.example.com", port: null },
      { name: "own.example.com", port: null, certResolver: "" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const keys = new Set(
    labels
      .map((l) => l.match(/^traefik\.http\.routers\.([^.]+)\./)?.[1])
      .filter(Boolean),
  );
  assert.equal(
    keys.size,
    2,
    `expected two routers, got ${[...keys].join(", ")}`,
  );
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app__3000-owncert.rule=Host(`own.example.com`)",
    ),
    labels.join("\n"),
  );
  assert.ok(
    !labels.some((l) =>
      l.startsWith(
        "traefik.http.routers.deplo-app__3000-owncert.tls.certresolver",
      ),
    ),
  );
});
