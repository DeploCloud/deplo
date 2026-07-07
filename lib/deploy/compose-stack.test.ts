import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "js-yaml";

import {
  buildComposeStack,
  detectDefaultService,
  type ComposeStackInput,
  type ComposeDomainRoute,
} from "./compose-stack";

/**
 * The `domains` table is the SOLE source of compose routing: each routed domain
 * (a {@link ComposeDomainRoute}) becomes exactly one Traefik router → its named
 * compose service. A route with no service (or one not in the stack) is skipped;
 * no routes ⇒ no routers. Separately, the contract that Deplo must NOT strip a
 * service's published `ports:` (host publishing is orthogonal to routing) holds.
 */

type Svc = {
  ports?: unknown[];
  networks?: unknown;
  labels?: unknown;
  environment?: unknown;
};
type Doc = { services: Record<string, Svc> };

/** A whole-host route to `service` on `port` (no path). */
function route(
  name: string,
  service: string,
  port: number | null = null,
): ComposeDomainRoute {
  return { name, service, port, pathPrefix: "", stripPrefix: false };
}

/** Build a stack from compose YAML + overrides and parse the result back. The
 * default routes `web` on the demo host (most tests have a single `web`). */
function buildDoc(compose: string, extra: Partial<ComposeStackInput> = {}): Doc {
  const out = buildComposeStack({
    compose,
    name: "deplo-demo",
    slug: "demo",
    serviceId: "p1",
    domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
    ...extra,
  });
  return yaml.load(out) as Doc;
}

/** The flattened label strings of a service (compose list form, post-build). */
function labelsOf(svc: Svc): string[] {
  return Array.isArray(svc.labels) ? (svc.labels as string[]) : [];
}

test("routed service keeps its published port (not stripped)", () => {
  const doc = buildDoc(
    `
services:
  minecraft:
    image: itzg/minecraft-server:latest
    ports:
      - "25565:25565"
`,
    { domainRoutes: [route("demo.1.2.3.4.nip.io", "minecraft", 25565)] },
  );
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
    labels.some((l) =>
      /^traefik\.http\.services\.deplo-demo-web-[^.]*\.loadbalancer\.server\.port=80$/.test(l),
    ),
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

/* ------------------------------------------------------------------ */
/* Routing comes ENTIRELY from domainRoutes (the domains table)        */
/* ------------------------------------------------------------------ */

const WEB_API_COMPOSE = `
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

test("each domain route becomes one router to its named service", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [
      route("web.1.2.3.4.nip.io", "web", 80),
      route("api.1.2.3.4.nip.io", "api", 8080),
    ],
  });
  const web = labelsOf(doc.services.web);
  const api = labelsOf(doc.services.api);
  assert.ok(web.some((l) => l.includes("Host(`web.1.2.3.4.nip.io`)")));
  assert.ok(web.some((l) => /loadbalancer\.server\.port=80$/.test(l)));
  assert.ok(api.some((l) => l.includes("Host(`api.1.2.3.4.nip.io`)")));
  assert.ok(api.some((l) => /loadbalancer\.server\.port=8080$/.test(l)));
  // Each routed service is wired onto the deplo network.
  assert.ok((doc.services.web.networks as string[]).includes("deplo"));
  assert.ok((doc.services.api.networks as string[]).includes("deplo"));
});

test("a route with null port falls back to the service's compose port", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [route("api.1.2.3.4.nip.io", "api", null)],
  });
  const api = labelsOf(doc.services.api);
  // Null port ⇒ read the service's published compose port (8080).
  assert.ok(api.some((l) => /loadbalancer\.server\.port=8080$/.test(l)));
});

test("a route whose service is null is skipped (no router emitted)", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [route("orphan.1.2.3.4.nip.io", null as unknown as string)],
  });
  // No service named ⇒ no router; neither service gets a Host() rule for it.
  const all = [...labelsOf(doc.services.web), ...labelsOf(doc.services.api)];
  assert.ok(!all.some((l) => l.includes("orphan.1.2.3.4.nip.io")));
});

test("a route whose service is absent from the stack is skipped", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [route("ghost.1.2.3.4.nip.io", "nonesuch", 1234)],
  });
  const all = [...labelsOf(doc.services.web), ...labelsOf(doc.services.api)];
  assert.ok(!all.some((l) => l.includes("ghost.1.2.3.4.nip.io")));
});

test("no domain routes ⇒ NO Traefik routers (the stack is built but unrouted)", () => {
  const doc = buildDoc(WEB_API_COMPOSE, { domainRoutes: [] });
  const all = [...labelsOf(doc.services.web), ...labelsOf(doc.services.api)];
  // Tracking labels still present, but no router/service/rule labels.
  assert.ok(all.includes("deplo.managed=true"));
  assert.ok(!all.some((l) => l.startsWith("traefik.http.routers.")));
  assert.ok(!all.some((l) => l.includes(".rule=")));
});

test("a path-scoped route emits a PathPrefix rule + stripprefix middleware", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [
      { name: "app.1.2.3.4.nip.io", service: "api", port: 8080, pathPrefix: "/api", stripPrefix: true },
    ],
  });
  const api = labelsOf(doc.services.api);
  assert.ok(api.some((l) => l.includes("PathPrefix(`/api`)")));
  assert.ok(api.some((l) => l.includes(".stripprefix.prefixes=/api")));
});

/* ------------------------------------------------------------------ */
/* detectDefaultService — used at project creation to seed domain 1    */
/* ------------------------------------------------------------------ */

test("detectDefaultService prefers a service that publishes a port", () => {
  assert.deepEqual(detectDefaultService(WEB_API_COMPOSE), { service: "web", port: 80 });
});

test("detectDefaultService falls back to the first service on port 80", () => {
  assert.deepEqual(
    detectDefaultService(`
services:
  only:
    image: nginx
`),
    { service: "only", port: 80 },
  );
});

test("detectDefaultService is null for empty / unparseable compose", () => {
  assert.equal(detectDefaultService(null), null);
  assert.equal(detectDefaultService(""), null);
  assert.equal(detectDefaultService("services: [this is not valid"), null);
});

/* ------------------------------------------------------------------ */
/* Service-files `./<x>` bind-mount rewrite                            */
/* ------------------------------------------------------------------ */

/** The volume sources of a service, post-build. */
function volsOf(svc: Svc & { volumes?: unknown }): string[] {
  return Array.isArray(svc.volumes) ? (svc.volumes as string[]) : [];
}

test("`./<x>` sources rewrite to the project's files dir; named/flags preserved", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    volumes:
      - ./config.toml:/etc/app/config.toml
      - ./nested/dir:/data:ro
      - appdata:/var/lib/app
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.web as Svc & { volumes?: unknown });
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
  web:
    image: nginx
    volumes:
      - ../sibling/data:/data
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.web as Svc & { volumes?: unknown });
  // Unchanged — the gate (isHostBindSource) is what rejects it, not the rewrite.
  assert.ok(vols.includes("../sibling/data:/data"));
});

test("an absolute host source is NOT rewritten", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    volumes:
      - /srv/host/data:/data
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.web as Svc & { volumes?: unknown });
  assert.ok(vols.includes("/srv/host/data:/data"));
});

/* ------------------------------------------------------------------ */
/* envKeys — settings env vars injected as bare `- KEY` pass-throughs  */
/* (the env analogue of the auto domain labels; values ride env-file)  */
/* ------------------------------------------------------------------ */

/** A service's `environment:`, normalised to a list of strings (the build always
 * emits list form when it injects, but a service it didn't touch may be a map). */
function envOf(svc: Svc): string[] {
  const e = svc.environment;
  if (Array.isArray(e)) return e.map(String);
  if (e && typeof e === "object") {
    return Object.entries(e as Record<string, unknown>).map(([k, v]) =>
      v === null || v === undefined ? k : `${k}=${String(v)}`,
    );
  }
  return [];
}

test("envKeys inject bare `- KEY` pass-throughs into EVERY service", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
  db:
    image: postgres
`,
    { envKeys: ["FOO", "BAR"], domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)] },
  );
  // The user picked "every service" — both the app and the sidecar get the keys,
  // as bare names (no value), so each reads its value from the env-file.
  assert.deepEqual(envOf(doc.services.web), ["FOO", "BAR"]);
  assert.deepEqual(envOf(doc.services.db), ["FOO", "BAR"]);
});

test("a key the service already declares (map value) is NOT overridden", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      FOO: hardcoded
`,
    { envKeys: ["FOO", "BAR"] },
  );
  const env = envOf(doc.services.web);
  // FOO keeps its compose-authored value; only the missing BAR is appended bare.
  assert.ok(env.includes("FOO=hardcoded"));
  assert.ok(env.includes("BAR"));
  assert.ok(!env.includes("FOO"), "FOO must not be duplicated as a bare key");
});

test("a key the service already declares (list `KEY=value`) is NOT overridden", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      - FOO=hardcoded
`,
    { envKeys: ["FOO", "BAR"] },
  );
  const env = envOf(doc.services.web);
  assert.deepEqual(env, ["FOO=hardcoded", "BAR"]);
});

test("a key the service already declares as a bare pass-through is kept once", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      - FOO
`,
    { envKeys: ["FOO", "BAR"] },
  );
  const env = envOf(doc.services.web);
  // FOO is already a pass-through — keep it as-is, append only BAR (no dupes).
  assert.deepEqual(env, ["FOO", "BAR"]);
});

test("a user `KEY=${VAR}` interpolation is preserved, not clobbered", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      - DATABASE_URL=postgres://app:\${DB_PASSWORD}@db:5432/app
`,
    { envKeys: ["DATABASE_URL", "DB_PASSWORD"] },
  );
  const env = envOf(doc.services.web);
  // The hand-written interpolation wins; only the otherwise-missing DB_PASSWORD
  // is injected as a bare pass-through.
  assert.ok(env.includes("DATABASE_URL=postgres://app:${DB_PASSWORD}@db:5432/app"));
  assert.ok(env.includes("DB_PASSWORD"));
});

test("empty envKeys ⇒ services with NO environment stay untouched", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
`);
  // No env injected and none authored ⇒ no `environment:` key materialises.
  assert.equal(doc.services.web.environment, undefined);
});

test("a map service whose keys are all already declared is left as a MAP (no churn)", () => {
  // mergeEnvironment must NOT rewrite a map to a list when it adds nothing —
  // that would change the YAML and force a needless reroute restart.
  const out = buildComposeStack({
    compose: `
services:
  web:
    image: nginx
    environment:
      FOO: a
      BAR: b
`,
    name: "deplo-demo",
    slug: "demo",
    serviceId: "p1",
    domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
    envKeys: ["FOO", "BAR"],
  });
  const doc = yaml.load(out) as Doc;
  // Still a map (object), not an array — nothing new was added.
  assert.ok(
    !Array.isArray(doc.services.web.environment) &&
      typeof doc.services.web.environment === "object",
  );
});

test("a `KEY:` map entry with a null value stays a bare pass-through when re-listed", () => {
  // The template convention: `environment:` with a value-less map key. When a
  // NEW key forces list-form, the existing null entry must emit as `KEY`, never
  // `KEY=null` (which would set the literal string "null").
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      EXISTING:
`,
    { envKeys: ["NEWKEY"] },
  );
  const env = envOf(doc.services.web);
  assert.deepEqual(env, ["EXISTING", "NEWKEY"]);
});
