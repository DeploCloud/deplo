import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "js-yaml";

import {
  buildComposeStack,
  detectDefaultApp,
  type ComposeStackInput,
  type ComposeDomainRoute,
} from "./compose-stack";
import type { VolumeMount } from "../types";

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
    appId: "p1",
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
/* detectDefaultApp — used at project creation to seed domain 1    */
/* ------------------------------------------------------------------ */

test("detectDefaultApp prefers a service that publishes a port", () => {
  assert.deepEqual(detectDefaultApp(WEB_API_COMPOSE), { service: "web", port: 80 });
});

test("detectDefaultApp falls back to the first service on port 80", () => {
  assert.deepEqual(
    detectDefaultApp(`
services:
  only:
    image: nginx
`),
    { service: "only", port: 80 },
  );
});

test("detectDefaultApp is null for empty / unparseable compose", () => {
  assert.equal(detectDefaultApp(null), null);
  assert.equal(detectDefaultApp(""), null);
  assert.equal(detectDefaultApp("services: [this is not valid"), null);
});

/* ------------------------------------------------------------------ */
/* App-files `./<x>` bind-mount rewrite                            */
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
/* Storage-settings volumes — a compose stack gets deplo-managed        */
/* persistent storage without the user hand-writing any `volumes:`      */
/* ------------------------------------------------------------------ */

/** A volume mount row as Storage settings stores it. */
function vol(
  v: Partial<VolumeMount> & { mountPath: string },
): VolumeMount {
  return { id: "vol_1", name: "data", readOnly: false, ...v };
}

/** The parsed top-level `volumes:` block. */
function topVolumes(doc: Doc): Record<string, { name?: string }> {
  return ((doc as unknown as { volumes?: unknown }).volumes ?? {}) as Record<
    string,
    { name?: string }
  >;
}

test("a named volume mounts into the stack's DEFAULT service and pins its host name", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
  db:
    image: postgres
`,
    { volumes: [vol({ name: "uploads", mountPath: "/app/uploads" })] },
  );
  // No service picked ⇒ the one a domain would route to (it publishes a port).
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "uploads:/app/uploads",
  ]);
  // NOT every service: a shared mount would race on first-use seeding.
  assert.deepEqual(volsOf(doc.services.db as Svc & { volumes?: unknown }), []);
  // The host name matches the single-container renderer's, so an app that
  // changes source keeps its data.
  assert.deepEqual(topVolumes(doc), { uploads: { name: "deplo-demo-uploads" } });
});

test("a volume mounts into the service it names, read-only flag included", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
  db:
    image: postgres
`,
    {
      volumes: [
        vol({ name: "pgdata", service: "db", mountPath: "/var/lib/postgresql/data" }),
        vol({ id: "vol_2", name: "seed", service: "db", mountPath: "/seed", readOnly: true }),
      ],
    },
  );
  assert.deepEqual(volsOf(doc.services.db as Svc & { volumes?: unknown }), [
    "pgdata:/var/lib/postgresql/data",
    "seed:/seed:ro",
  ]);
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), []);
});

test("the service's OWN mount at that path wins (existing-wins)", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    volumes:
      - authored:/data
`,
    { volumes: [vol({ name: "data", mountPath: "/data" })] },
  );
  // The authored compose is authoritative — same precedence as envKeys/resources.
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "authored:/data",
  ]);
  // …and the skipped mount leaves NO orphan top-level entry behind (compose
  // would create that empty volume, and every backup would then carry it).
  assert.deepEqual(topVolumes(doc), {});
});

test("app-file and host volumes render as binds, with no top-level entry", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
`,
    {
      filesDir: "/srv/stacks/files/demo",
      volumes: [
        vol({ id: "vol_1", type: "app", name: "conf", projectPath: "config.toml", mountPath: "/etc/app/config.toml" }),
        vol({ id: "vol_2", type: "host", name: "media", hostPath: "/srv/media", mountPath: "/media" }),
      ],
    },
  );
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "/srv/stacks/files/demo/config.toml:/etc/app/config.toml",
    "/srv/media:/media",
  ]);
  // Binds have an absolute source — docker needs no top-level declaration.
  assert.deepEqual(topVolumes(doc), {});
});

test("a top-level key the compose already uses is not clobbered", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
volumes:
  data:
    external: true
`,
    { volumes: [vol({ name: "data", mountPath: "/data" })] },
  );
  const top = topVolumes(doc);
  // The user's `data:` keeps its own declaration; ours takes the next free alias
  // (its host name is still derived from the volume's name).
  assert.deepEqual(top.data, { external: true });
  assert.deepEqual(top["data-2"], { name: "deplo-demo-data" });
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "data-2:/data",
  ]);
});

test("a volume naming a service the compose lacks is a hard error", () => {
  assert.throws(
    () =>
      buildDoc(
        `
services:
  web:
    image: nginx
`,
        { volumes: [vol({ name: "data", service: "worker", mountPath: "/data" })] },
      ),
    /worker/,
  );
});

test("no volumes ⇒ no `volumes:` key anywhere (byte-identical baseline)", () => {
  const base = buildComposeStack({
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-demo",
    slug: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
  });
  const withEmpty = buildComposeStack({
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-demo",
    slug: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
    volumes: [],
  });
  assert.equal(withEmpty, base);
  assert.ok(!base.includes("volumes:"));
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
    appId: "p1",
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

/* ------------------------------------------------------------------ */
/* build.labels: tracking labels reach the IMAGES compose builds       */
/* ------------------------------------------------------------------ */

type BuildSvc = Svc & { build?: { context?: string; labels?: unknown } | string };

test("a service with `build:` gets the tracking labels ON THE IMAGE (build.labels)", () => {
  // Container labels don't reach the image config, which left compose-BUILT
  // images invisible to the cleanup's unused_app_images scope forever. The
  // build.labels below are what makes each rebuilt generation reclaimable —
  // deplo.service included, so the agent ranks each service's images apart.
  const doc = buildDoc(`
services:
  web:
    build:
      context: ./web
  worker:
    build: ./worker
  db:
    image: postgres:16
`) as { services: Record<string, BuildSvc> };

  const web = doc.services.web.build;
  assert.ok(web && typeof web === "object");
  assert.deepEqual(web.labels, [
    "deplo.managed=true",
    "deplo.project=p1",
    "deplo.slug=demo",
    "deplo.service=web",
  ]);

  // The string shorthand normalises to the object form compose treats identically.
  const worker = doc.services.worker.build;
  assert.ok(worker && typeof worker === "object");
  assert.equal(worker.context, "./worker");
  assert.deepEqual(worker.labels, [
    "deplo.managed=true",
    "deplo.project=p1",
    "deplo.slug=demo",
    "deplo.service=worker",
  ]);

  // A pulled image is not ours to mark: no build section is ever invented.
  assert.equal(doc.services.db.build, undefined);
});

test("existing build.labels survive (map or list) and colliding keys are replaced", () => {
  const doc = buildDoc(`
services:
  web:
    build:
      context: .
      labels:
        com.example.team: platform
        deplo.slug: stale
`) as { services: Record<string, BuildSvc> };

  const build = doc.services.web.build;
  assert.ok(build && typeof build === "object");
  assert.deepEqual(build.labels, [
    "com.example.team=platform",
    "deplo.managed=true",
    "deplo.project=p1",
    "deplo.slug=demo",
    "deplo.service=web",
  ]);
});
