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

// --- Per-route TLS triplet (entrypoint / tls on-off / cert resolver) --------

test("tls:false serves plain HTTP on the web entrypoint — no tls labels", () => {
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
  // The HTTP router carries no tls labels; the default one does.
  assert.ok(labels.includes("traefik.http.routers.deplo-app.tls=true"));
  assert.ok(!labels.some((l) => l.startsWith("traefik.http.routers.deplo-app__3000-http.tls")));
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
  // Default-resolver host keeps the bare key; the cloudflare host gets its own.
  assert.ok(
    labels.includes("traefik.http.routers.deplo-app.tls.certresolver=letsencrypt"),
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
  // Passing certResolver explicitly equal to the call default must not churn the
  // router key — the route still belongs to the bare default group.
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "x.example.com", port: null, certResolver: CR, entrypoint: "websecure", tls: true }],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(labels.includes("traefik.http.routers.deplo-app.rule=Host(`x.example.com`)"));
  assert.ok(!labels.some((l) => l.includes("deplo-app__")));
});

test("a middleware chain emits an ordered middlewares= label on the default router", () => {
  assert.deepEqual(
    traefikRouterLabels({
      baseKey: "deplo-app",
      routes: [{ name: "app.com", port: null, middlewares: ["redirect-https", "auth@file"] }],
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
  // Blank-only chain collapses to empty ⇒ the route stays in the bare default group.
  assert.ok(labels.includes("traefik.http.routers.deplo-app.rule=Host(`app.com`)"));
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

test("a resolver name with unsafe characters is sanitised in the router key", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "x.example.com", port: null, certResolver: "My Resolver!" }],
    defaultPort: 3000,
    certResolver: CR,
  });
  // The key segment is sanitised to [a-z0-9-]; the LABEL value keeps the raw name.
  assert.ok(labels.some((l) => l.startsWith("traefik.http.routers.deplo-app__3000-my-resolver.")));
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app__3000-my-resolver.tls.certresolver=My Resolver!",
    ),
  );
});

// --- Per-route path prefix (PathPrefix) + strip prefix (stripprefix mw) -------

test("a path prefix appends && PathPrefix to a parenthesised Host group + priority", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.com", port: null, pathPrefix: "/api" }],
    defaultPort: 3000,
    certResolver: CR,
  });
  // Rule wraps the Host group in parens (so && binds across all hosts) and adds
  // PathPrefix; a priority label equal to the prefix length is emitted; NO
  // stripprefix / middlewares label (strip not requested).
  assert.ok(
    labels.some((l) => l.includes(".rule=(Host(`app.com`)) && PathPrefix(`/api`)")),
  );
  const ruleLine = labels.find((l) => l.includes(".rule="))!;
  const key = ruleLine.slice("traefik.http.routers.".length, ruleLine.indexOf(".rule="));
  assert.ok(key.startsWith("deplo-app__3000-path-api-"), `key was ${key}`);
  assert.ok(labels.includes(`traefik.http.routers.${key}.priority=4`));
  assert.ok(!labels.some((l) => l.includes(".stripprefix.")));
  assert.ok(!labels.some((l) => l.includes(".middlewares=")));
});

test("strip prefix emits a stripprefix middleware prepended to the (empty) chain", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.com", port: null, pathPrefix: "/api", stripPrefix: true }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const ruleLine = labels.find((l) => l.includes(".rule="))!;
  const key = ruleLine.slice("traefik.http.routers.".length, ruleLine.indexOf(".rule="));
  assert.ok(key.endsWith("-strip"), `key was ${key}`);
  assert.ok(
    labels.includes(
      `traefik.http.middlewares.${key}-stripprefix.stripprefix.prefixes=/api`,
    ),
  );
  // With no user middlewares the chain is exactly the generated strip mw.
  assert.ok(
    labels.includes(`traefik.http.routers.${key}.middlewares=${key}-stripprefix`),
  );
});

test("strip prefix prepends the strip mw BEFORE user middlewares (order)", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "app.com", port: null, pathPrefix: "/api", stripPrefix: true, middlewares: ["auth@file"] },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const ruleLine = labels.find((l) => l.includes(".rule="))!;
  const key = ruleLine.slice("traefik.http.routers.".length, ruleLine.indexOf(".rule="));
  assert.ok(
    labels.includes(
      `traefik.http.routers.${key}.middlewares=${key}-stripprefix,auth@file`,
    ),
  );
});

test("stripPrefix:true with NO path is a no-op — byte-identical to a bare route", () => {
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
  assert.ok(rules[0].includes("(Host(`a.com`) || Host(`b.com`)) && PathPrefix(`/api`)"));
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
  // `/api` + strip and `/api-strip` (no strip) both reduce to the readable
  // segment `path-api-strip` under safe(); the injective hash must keep their
  // keys apart, else two routers share a name (last-write-wins).
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
      routes: [{ name: "app.com", port: null, pathPrefix: "/api", stripPrefix: true }],
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
    labels.some((l) => l.includes("traefik.http.routers.deplo-svc-8080.rule=(Host(`app.com`)) && PathPrefix(`/api`)")),
  );
  assert.ok(
    labels.includes("traefik.http.middlewares.deplo-svc-8080-stripprefix.stripprefix.prefixes=/api"),
  );
  assert.ok(labels.includes("traefik.http.routers.deplo-svc-8080.priority=4"));
  // The path-less route stays byte-identical (no PathPrefix / priority / strip).
  assert.ok(labels.includes("traefik.http.routers.deplo-svc-3000.rule=Host(`app.com`)"));
  assert.ok(!labels.some((l) => l.startsWith("traefik.http.routers.deplo-svc-3000.priority")));
});

// --- Single-image backfill invariant: storing port = build.port explicitly must
// render byte-identically to leaving it null. This is what lets the data layer
// always write a concrete port onto single-image domains (so none is portless)
// without rerouting / restarting any existing single-image container. ---

test("single-image: explicit port == defaultPort renders byte-identically to null", () => {
  const nullPort = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const explicitPort = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: 3000 }], // == defaultPort
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
      { name: "b.example.com", port: 3000 }, // explicit but == defaultPort
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  // One router, one OR-rule, single loadbalancer port — no __3000 split.
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-app.rule=Host(`a.example.com`) || Host(`b.example.com`)",
    ),
  );
  assert.ok(
    labels.includes("traefik.http.services.deplo-app.loadbalancer.server.port=3000"),
  );
  assert.ok(!labels.some((l) => l.includes("deplo-app__3000")));
});
