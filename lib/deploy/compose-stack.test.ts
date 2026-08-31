import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../yaml";

import {
  buildComposeStack,
  composeDeclaredEnvKeys,
  detectDefaultApp,
  composeEnvValues,
  composeNamesOnNetwork,
  escapeComposeDollars,
  retargetStackNetwork,
  stackNamesOnNetwork,
  type ComposeStackInput,
  type ComposeDomainRoute,
} from "./compose-stack";
import type { VolumeMount } from "../types";

/**
 * The `domains` table is the SOLE source of compose routing: each routed domain (a
 * {@link ComposeDomainRoute}) becomes exactly one Traefik router → its named
 * compose service.
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
function buildDoc(
  compose: string,
  extra: Partial<ComposeStackInput> = {},
): Doc {
  const out = buildComposeStack({
    network: "deplo-team-team_test",
    compose,
    name: "deplo-demo",
    deployKey: "demo",
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
  // Routing rides the deplo network to the container port - orthogonal to host
  // publishing, so the labels coexist with the kept ports.
  assert.ok(
    labels.includes("traefik.docker.network=deplo-team-team_test"),
    "Traefik is pinned to the stack's OWN network, not the platform's",
  );
  assert.ok(
    labels.some((l) =>
      /^traefik\.http\.services\.deplo-demo-web-[^.]*\.loadbalancer\.server\.port=80$/.test(
        l,
      ),
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

test("a user-authored traefik.* label is stripped; Deplo's own routers survive", () => {
  // Hostname hijack attempt: the author hand-writes a router claiming another
  // team's host. The `domains` table is the ONLY routing source, so it must not
  // survive, while Deplo's own domains-derived router for a real domain stays.
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    labels:
      - traefik.http.routers.evil.rule=Host(\`victim.com\`)
      - traefik.http.routers.evil.priority=1000
      - com.example.keep=yes
`,
    { domainRoutes: [route("real.1.2.3.4.nip.io", "web", 80)] },
  );
  const labels = labelsOf(doc.services.web);
  // The attacker's router is gone entirely.
  assert.ok(!labels.some((l) => l.includes("victim.com")));
  assert.ok(!labels.some((l) => l.includes("routers.evil")));
  // A non-traefik user label is untouched.
  assert.ok(labels.includes("com.example.keep=yes"));
  // Deplo's own routing for the real domain is present.
  assert.ok(labels.some((l) => l.includes("Host(`real.1.2.3.4.nip.io`)")));
  assert.ok(
    labels.includes("traefik.docker.network=deplo-team-team_test"),
    "Traefik is pinned to the stack's OWN network, not the platform's",
  );
});

test("a label whose KEY comes from a variable is dropped, router and all", () => {
  // `- "${LBL}"` is ONE value to compose, so the env-file supplies the whole
  // `key=value` pair - a router rule claiming any hostname, past a strip that only
  // ever saw the literal text `${LBL}`.
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    labels:
      - \${LBL}
      - com.example.version=\${TAG}
`,
    { domainRoutes: [route("real.1.2.3.4.nip.io", "web", 80)] },
  );
  const labels = labelsOf(doc.services.web);
  assert.ok(!labels.some((l) => l.startsWith("${LBL}")));
  // A label whose VALUE interpolates is ordinary and stays: only the key decides.
  assert.ok(labels.includes("com.example.version=${TAG}"));
});

test("a user traefik.* label in MAP form is stripped too", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    labels:
      traefik.http.routers.evil.rule: Host(\`victim.com\`)
      com.example.keep: yes
`,
    { domainRoutes: [route("real.1.2.3.4.nip.io", "web", 80)] },
  );
  const labels = labelsOf(doc.services.web);
  assert.ok(!labels.some((l) => l.includes("victim.com")));
  assert.ok(labels.some((l) => l.startsWith("com.example.keep=")));
  assert.ok(labels.some((l) => l.includes("Host(`real.1.2.3.4.nip.io`)")));
});

test("a path-scoped route emits a PathPrefix rule + stripprefix middleware", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [
      {
        name: "app.1.2.3.4.nip.io",
        service: "api",
        port: 8080,
        pathPrefix: "/api",
        stripPrefix: true,
      },
    ],
  });
  const api = labelsOf(doc.services.api);
  assert.ok(api.some((l) => l.includes("PathPrefix(`/api`)")));
  assert.ok(api.some((l) => l.includes(".stripprefix.prefixes=/api")));
});

/* ------------------------------------------------------------------ */
/* detectDefaultApp - used at project creation to seed domain 1    */
/* ------------------------------------------------------------------ */

test("detectDefaultApp prefers a service that publishes a port", () => {
  assert.deepEqual(detectDefaultApp(WEB_API_COMPOSE), {
    service: "web",
    port: 80,
  });
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

test("detectDefaultApp skips a service named after deplo's own network names", () => {
  // The first-service fallback used to hand back `postgres`, and a domain routed
  // there makes every later render of the stack throw - the app deploys once and
  // never again.
  assert.deepEqual(
    detectDefaultApp(`
services:
  postgres:
    image: postgres:16
  web:
    image: nginx
`),
    { service: "web", port: 80 },
  );
  assert.equal(
    detectDefaultApp(`
services:
  traefik:
    image: traefik:v3
    ports:
      - "80:80"
`),
    null,
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
  assert.ok(
    vols.includes("/srv/stacks/files/demo/config.toml:/etc/app/config.toml"),
  );
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
  // Unchanged - the gate (isHostBindSource) is what rejects it, not the rewrite.
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
/* Storage-settings volumes - a compose stack gets deplo-managed        */
/* persistent storage without the user hand-writing any `volumes:`      */
/* ------------------------------------------------------------------ */

/** A volume mount row as Storage settings stores it. */
function vol(v: Partial<VolumeMount> & { mountPath: string }): VolumeMount {
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
  assert.deepEqual(topVolumes(doc), {
    uploads: { name: "deplo-demo-uploads" },
  });
});

test("a volume with no service named stays where it always landed", () => {
  const doc = buildDoc(
    `
services:
  db:
    image: postgres:17
  web:
    image: nginx
`,
    {
      domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
      volumes: [vol({ name: "data", mountPath: "/data" })],
    },
  );
  // A DOMAIN skips a database now; this mount deliberately does not follow that
  // rule - an existing app would find its data in another container after one
  // redeploy.
  assert.deepEqual(volsOf(doc.services.db as Svc & { volumes?: unknown }), [
    "data:/data",
  ]);
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), []);
});

test("a route with no port of its own uses the port the service exposes", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: acme/web
    expose:
      - "8080"
`,
    { domainRoutes: [route("demo.1.2.3.4.nip.io", "web", null)] },
  );
  assert.ok(
    labelsOf(doc.services.web).some((l) =>
      l.endsWith("loadbalancer.server.port=8080"),
    ),
    "expected the exposed port, not the conventional 80",
  );
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
        vol({
          name: "pgdata",
          service: "db",
          mountPath: "/var/lib/postgresql/data",
        }),
        vol({
          id: "vol_2",
          name: "seed",
          service: "db",
          mountPath: "/seed",
          readOnly: true,
        }),
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
  // The authored compose is authoritative - same precedence as envKeys/resources.
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
        vol({
          id: "vol_1",
          type: "app",
          name: "conf",
          projectPath: "config.toml",
          mountPath: "/etc/app/config.toml",
        }),
        vol({
          id: "vol_2",
          type: "host",
          name: "media",
          hostPath: "/srv/media",
          mountPath: "/media",
        }),
      ],
    },
  );
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "/srv/stacks/files/demo/config.toml:/etc/app/config.toml",
    "/srv/media:/media",
  ]);
  // Binds have an absolute source - docker needs no top-level declaration.
  assert.deepEqual(topVolumes(doc), {});
});

test("a host bind's propagation reaches the injected mount line", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
`,
    {
      volumes: [
        vol({
          id: "vol_1",
          type: "host",
          name: "neon",
          hostPath: "/srv/neon",
          mountPath: "/srv/neon",
          propagation: "rslave",
        }),
      ],
    },
  );
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "/srv/neon:/srv/neon:rslave",
  ]);
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
        {
          volumes: [
            vol({ name: "data", service: "worker", mountPath: "/data" }),
          ],
        },
      ),
    /worker/,
  );
});

test("no volumes ⇒ no `volumes:` key anywhere (byte-identical baseline)", () => {
  const base = buildComposeStack({
    network: "deplo-team-team_test",
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
  });
  const withEmpty = buildComposeStack({
    network: "deplo-team-team_test",
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
    volumes: [],
  });
  assert.equal(withEmpty, base);
  assert.ok(!base.includes("volumes:"));
});

/* ------------------------------------------------------------------ */
/* envKeys - settings env vars injected as bare `- KEY` pass-throughs  */
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
    {
      envKeys: ["FOO", "BAR"],
      domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
    },
  );
  // The user picked "every service" - both the app and the sidecar get the keys,
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
  // FOO is already a pass-through - keep it as-is, append only BAR (no dupes).
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
  assert.ok(
    env.includes("DATABASE_URL=postgres://app:${DB_PASSWORD}@db:5432/app"),
  );
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
  // mergeEnvironment must NOT rewrite a map to a list when it adds nothing -
  // that would change the YAML and force a needless reroute restart.
  const out = buildComposeStack({
    network: "deplo-team-team_test",
    compose: `
services:
  web:
    image: nginx
    environment:
      FOO: a
      BAR: b
`,
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.nip.io", "web", 80)],
    envKeys: ["FOO", "BAR"],
  });
  const doc = yaml.load(out) as Doc;
  // Still a map (object), not an array - nothing new was added.
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

type BuildSvc = Svc & {
  build?: { context?: string; labels?: unknown } | string;
};

test("a service with `build:` gets the tracking labels ON THE IMAGE (build.labels)", () => {
  // Container labels don't reach the image config, which left compose-BUILT images
  // invisible to the cleanup's unused_app_images scope forever.
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

/**
 * The shared network is the platform's, not the stack's.
 */
test("a hand-written alias on the shared network does not survive the render", () => {
  const out = buildComposeStack({
    network: "deplo-team-team_test",
    compose: `services:
  web:
    image: nginx
    networks:
      deplo:
        aliases: [postgres, deplo]
networks:
  deplo: {external: true}`,
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [],
  });
  assert.ok(!out.includes("aliases"), `an alias survived:\n${out}`);
});

// Flattening the long form to a list dropped the author's own options on their own
// private networks - legitimate now that a stack shares a network with nobody.
test("long-form `networks:` keeps its options; the stack's network is added", () => {
  const doc = buildDoc(`services:
  web:
    image: nginx
    networks:
      interna:
        aliases: [cache]
        ipv4_address: 10.5.0.9
networks:
  interna: {}`);
  const nets = doc.services.web.networks as Record<string, unknown>;
  assert.ok(!Array.isArray(nets), "the map must stay a map");
  assert.deepEqual(nets.interna, {
    aliases: ["cache"],
    ipv4_address: "10.5.0.9",
  });
  assert.equal(nets.deplo, null, "joined with no options");
});

test("a service claiming one of Deplo's own names on the shared network is refused", () => {
  for (const name of ["deplo", "postgres", "traefik"]) {
    assert.throws(
      () =>
        buildComposeStack({
          network: "deplo-team-team_test",
          compose: `services:\n  ${name}:\n    image: alpine\n    networks: [deplo]\nnetworks:\n  deplo: {external: true}`,
          name: "deplo-demo",
          deployKey: "demo",
          appId: "p1",
          domainRoutes: [],
        }),
      /is a name Deplo's own infrastructure answers to/,
      `${name} was allowed`,
    );
  }
});

test("an OLD domain routed at a reserved name is skipped, not fatal", () => {
  // Stored before the domain layer refused it: the stack has to keep deploying,
  // with that one hostname unrouted, rather than throwing on every render.
  const doc = buildDoc(
    `services:
  postgres:
    image: postgres:16
  web:
    image: nginx
`,
    {
      domainRoutes: [
        route("db.1.2.3.4.nip.io", "postgres", 5432),
        route("app.1.2.3.4.nip.io", "web", 80),
      ],
    },
  );
  const pg = labelsOf(doc.services.postgres);
  assert.ok(!pg.some((l) => l.includes("db.1.2.3.4.nip.io")));
  assert.ok(
    !(doc.services.postgres.networks as string[] | undefined)?.includes(
      "deplo",
    ),
    "the reserved service must not be put on the shared network",
  );
  // The app's real hostname still works.
  assert.ok(
    labelsOf(doc.services.web).some((l) =>
      l.includes("Host(`app.1.2.3.4.nip.io`)"),
    ),
  );
});

test("the shared network is resolved by NAME, not by the key it is given", () => {
  // `{ sneaky: { external: true, name: deplo } }` IS the shared network. A rule
  // that matched the key alone was one rename away from decorative.
  const sneaky = (service: string) => `services:
  ${service}:
    image: alpine
    networks:
      sneaky:
        aliases: [deplo]
networks:
  sneaky: {external: true, name: deplo}`;

  assert.throws(
    () =>
      buildComposeStack({
        network: "deplo-team-team_test",
        compose: sneaky("postgres"),
        name: "deplo-demo",
        deployKey: "demo",
        appId: "p1",
        domainRoutes: [],
      }),
    /is a name Deplo's own infrastructure answers to/,
  );

  const out = buildComposeStack({
    network: "deplo-team-team_test",
    compose: sneaky("app"),
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [],
  });
  assert.ok(!out.includes("aliases"), `an alias survived:\n${out}`);
});

/* ------------------------------------------------------------------ */
/* a route's own certificate choice                                     */
/* ------------------------------------------------------------------ */

/**
 * A compose route was rendered with the DEFAULT TLS triplet whatever its domain
 * asked for, because `ComposeDomainRoute` never declared the three fields the
 * caller was already passing.
 */
test("buildComposeStack: a route with no certificate lands on the web entrypoint", () => {
  const yaml = buildComposeStack({
    network: "deplo-team-team_test",
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-app",
    deployKey: "app",
    appId: "prj_1",
    filesDir: "/data/stacks/files/app",
    domainRoutes: [
      {
        name: "app-quiet-heron-0a000001.nip.io",
        service: "web",
        port: 80,
        entrypoint: "web",
        tls: false,
        certResolver: "",
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  assert.match(yaml, /entrypoints=web\b/);
  assert.equal(/entrypoints=websecure/.test(yaml), false, yaml);
  assert.equal(/tls=true/.test(yaml), false, yaml);
  assert.equal(/certresolver/.test(yaml), false, yaml);
});

test("buildComposeStack: a route that asked for a certificate still gets one", () => {
  const yaml = buildComposeStack({
    network: "deplo-team-team_test",
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-app",
    deployKey: "app",
    appId: "prj_1",
    filesDir: "/data/stacks/files/app",
    domainRoutes: [
      {
        name: "app.acme.com",
        service: "web",
        port: 80,
        entrypoint: "websecure",
        tls: true,
        certResolver: "letsencrypt",
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  assert.match(yaml, /entrypoints=websecure/);
  assert.match(yaml, /tls=true/);
  assert.match(yaml, /tls\.certresolver=letsencrypt/);
});

/**
 * `network_mode` and `networks` are mutually exclusive in Compose, and the failure
 * is not local to the service: `docker compose up` refuses the WHOLE project
 * ("service X declares mutually exclusive `network_mode` and `networks`: invalid
 * compose project"), so one host-network container would stop every other service
 * in the stack from starting.
 */
test("a network_mode service is left alone: no networks key, no router", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
  agent:
    image: alpine
    network_mode: host
`,
    {
      domainRoutes: [
        route("demo.1.2.3.4.nip.io", "web", 80),
        route("agent.1.2.3.4.nip.io", "agent", 8123),
      ],
    },
  );
  assert.equal(doc.services.agent.networks, undefined);
  assert.equal(
    (doc.services.agent as { network_mode?: unknown }).network_mode,
    "host",
  );
  assert.deepEqual(
    labelsOf(doc.services.agent).filter((l) => l.startsWith("traefik.")),
    [],
  );
  // The rest of the stack is routed exactly as before.
  assert.ok((doc.services.web.networks as string[]).includes("deplo"));
  assert.ok(
    labelsOf(doc.services.web).some((l) =>
      l.includes("Host(`demo.1.2.3.4.nip.io`)"),
    ),
  );
});

test("a single-service stack in host network mode still renders a valid project", () => {
  const doc = buildDoc(
    `
services:
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:2024.8
    network_mode: host
    privileged: true
`,
    { domainRoutes: [route("ha.1.2.3.4.nip.io", "homeassistant", 8123)] },
  );
  assert.equal(doc.services.homeassistant.networks, undefined);
  assert.deepEqual(
    labelsOf(doc.services.homeassistant).filter((l) =>
      l.startsWith("traefik."),
    ),
    [],
  );
});

test("the env text the author typed is the text the container gets", () => {
  // `022` is a umask and `1.10` is a version. Read as numbers they come back out
  // as 22 and 1.1, and the container is handed a value nobody wrote.
  const doc = buildDoc(`x-common: &common
  environment:
    UMASK: 022
services:
  web:
    image: nginx
    environment:
      VER: 1.10
      PORT: 8080
      OK: true
      TXT: hello
  side:
    <<: *common
    image: alpine
`);
  const env = doc.services.web.environment as unknown as Record<
    string,
    unknown
  >;
  assert.equal(env.VER, "1.10");
  // Also inside the anchor a service merges from, which is where a big stack
  // keeps its shared defaults.
  assert.equal(
    (doc.services.side.environment as unknown as Record<string, unknown>).UMASK,
    "022",
  );
  // A number that IS a number, a boolean and a string are left as they are.
  assert.equal(env.PORT, 8080);
  assert.equal(env.OK, true);
  assert.equal(env.TXT, "hello");
});

test("a compose that needs no requoting is read as it was", () => {
  const doc = buildDoc(
    "services:\n  web:\n    image: nginx\n    environment:\n      A: '1'\n",
  );
  assert.deepEqual(doc.services.web.environment, { A: "1" });
});

test("composeDeclaredEnvKeys names the keys the authored YAML sets itself", () => {
  // A bare `KEY` is the pass-through Deplo writes; a `KEY=value` (or a mapped one)
  // is the compose author's own value, which `mergeEnvironment` leaves alone - so
  // the Environment tab has to say the variable set there does not reach it.
  assert.deepEqual(
    composeDeclaredEnvKeys(
      [
        "services:",
        "  web:",
        "    environment:",
        "      - SET=1",
        "      - PASSTHROUGH",
        "  api:",
        "    environment:",
        "      MAPPED: x",
        "      BARE:",
      ].join("\n"),
    ).sort(),
    ["MAPPED", "SET"],
  );
  assert.deepEqual(composeDeclaredEnvKeys(null), []);
  assert.deepEqual(composeDeclaredEnvKeys("not: [valid"), []);
});

test("escapeComposeDollars doubles a $ and leaves everything else alone", () => {
  assert.equal(escapeComposeDollars('"plain"'), '"plain"');
  assert.equal(escapeComposeDollars('"a$b"'), '"a$$b"');
  assert.equal(escapeComposeDollars('"${X}"'), '"$${X}"');
});

/** The top-level `networks:` of a built stack, which `buildDoc` does not model. */
function networksOf(compose: string, extra: Partial<ComposeStackInput> = {}) {
  const out = buildComposeStack({
    network: "deplo-env-environ_mine",
    compose,
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [],
    ...extra,
  });
  return yaml.load(out) as {
    networks: Record<string, { name?: string }>;
    services: Record<string, { networks?: string[] }>;
  };
}

test("a `default` pointed at another tenant's network is collapsed, not honoured", () => {
  // The bypass this closes: no service declares `networks:`, so every gate that
  // only looked at an explicit join saw nothing at all.
  const doc = networksOf(`
networks:
  default:
    external: true
    name: deplo-env-environ_victim
services:
  spy:
    image: alpine
`);
  assert.deepEqual(Object.keys(doc.networks), ["deplo"]);
  assert.equal(doc.networks.deplo.name, "deplo-env-environ_mine");
  assert.deepEqual(doc.services.spy.networks, ["deplo"]);
});

test("a reserved name reached through an implicit `default` is refused", () => {
  assert.throws(
    () =>
      networksOf(`
networks:
  default:
    external: true
    name: deplo-env-environ_victim
services:
  deplo:
    image: alpine
`),
    /answers to/,
  );
});

test("a foreign key and the stack's own network never both name it", () => {
  const doc = networksOf(`
networks:
  victim:
    external: true
    name: deplo-team-team_victim
services:
  a:
    image: alpine
    networks: [victim]
`);
  assert.deepEqual(Object.keys(doc.networks), ["deplo"]);
  // Attached ONCE: two keys naming one network is a container docker refuses.
  assert.deepEqual(doc.services.a.networks, ["deplo"]);
});

test("a private network of the author's own is kept, and joined by the stack's", () => {
  const doc = networksOf(`
networks:
  internal:
    driver: bridge
services:
  a:
    image: alpine
    networks: [internal]
`);
  // Theirs survives untouched and the Environment's is ADDED: naming a network is
  // organising, not asking to be cut off. `internal: true` is how you ask for that.
  assert.ok("internal" in doc.networks);
  assert.deepEqual(doc.services.a.networks, ["internal", "deplo"]);
});

test("every service joins the Environment's network, routed or not", () => {
  const doc = networksOf(`
services:
  web:
    image: nginx
  worker:
    image: alpine
`);
  assert.deepEqual(doc.services.web.networks, ["deplo"]);
  assert.deepEqual(doc.services.worker.networks, ["deplo"]);
  // No `default` asked for, so compose creates no `<project>_default` - one network
  // per stack the host does not have to find address space for.
  assert.deepEqual(Object.keys(doc.networks), ["deplo"]);
});

test("a reserved name is left off the shared network, but not off the stack", () => {
  // `postgres` is an ordinary name for a stack's own database. It cannot go on the
  // Environment's network, but the rest of the stack still has to REACH it: leaving
  // it off both split the stack in two and `web -> postgres` stopped resolving.
  const doc = networksOf(`
services:
  postgres:
    image: postgres:16
  web:
    image: nginx
`);
  assert.deepEqual(doc.services.postgres.networks, ["default"]);
  assert.deepEqual(doc.services.web.networks, ["default", "deplo"]);
});

test("a hostname claiming a reserved name is caught like the service name", () => {
  const doc = networksOf(`
services:
  store:
    image: postgres:16
    hostname: postgres
  web:
    image: nginx
`);
  assert.deepEqual(doc.services.store.networks, ["default"]);
  assert.deepEqual(doc.services.web.networks, ["default", "deplo"]);
});

test("network_mode is refused for `$VAR` without braces too", () => {
  // Compose interpolates `$NET` exactly like `${NET}` - the same thing
  // `escapeComposeDollars` in this file has always said.
  for (const mode of ["${NET}", "$NET", "$NET-suffix", "$(NET)"])
    assert.throws(
      () =>
        networksOf(
          `services:\n  s:\n    image: a\n    network_mode: "${mode}"\n`,
        ),
      /filled in from a variable/,
      mode,
    );
  // `$$` is compose's escape for a literal dollar and interpolates nothing.
  assert.doesNotThrow(() =>
    networksOf(`services:\n  s:\n    image: a\n    network_mode: "a$$b"\n`),
  );
});

test("another tenant's private default is a network Deplo manages", () => {
  assert.throws(
    () =>
      networksOf(
        "services:\n  s:\n    image: a\n    network_mode: deplo-victim_default\n",
      ),
    /names a network Deplo manages/,
  );
});

test("the author's own `default` is honoured, not overridden", () => {
  // Declaring it is a choice about where the services that name nothing belong -
  // `internal: true` is somebody deliberately cutting off egress.
  const doc = networksOf(`
networks:
  default:
    internal: true
services:
  w:
    image: alpine
`);
  assert.equal(doc.services.w.networks, undefined);
});

test("stackNamesOnNetwork reads only what joined the stack's network", () => {
  // A `network_mode` service joins nothing, so it answers to nobody.
  const rendered = buildComposeStack({
    network: "deplo-env-environ_mine",
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    compose: `
services:
  web:
    image: nginx
    hostname: api
  sidecar:
    image: alpine
    networks: [priv]
networks:
  priv: {}
`,
    domainRoutes: [route("shop.example.com", "web", 80)],
  });
  // `sidecar` keeps its own network AND joins the Environment's, so it answers
  // there too. Only a `network_mode` service, a reserved name or an `internal:
  // true` network stays off.
  assert.deepEqual(stackNamesOnNetwork(rendered).sort(), [
    "api",
    "sidecar",
    "web",
  ]);
});

test("network_mode may not name a network Deplo manages", () => {
  const render = (mode: string) =>
    networksOf(
      `services:\n  s:\n    image: alpine\n    network_mode: ${mode}\n`,
    );
  for (const mode of [
    "deplo",
    "deplo-internal",
    "traefik_deplo-socket", // the socket proxy, under its compose project prefix
    "deplo-env-environ_victim",
    "deplo-team-team_victim",
  ])
    assert.throws(() => render(mode), /names a network Deplo manages/, mode);
  // Filled in at `compose up` from the env-file, so the authored text never shows
  // which network it is - the one shape no static check can catch.
  assert.throws(() => render("${DEPLO_NET}"), /filled in from a variable/);
  // What is left is either harmless or already behind the host grant.
  for (const mode of ["none", "host", "service:sibling"])
    assert.doesNotThrow(() => render(mode), mode);
});

test("a routed service that joins no network is reported, not dropped silently", () => {
  const warnings: string[] = [];
  buildComposeStack({
    network: "deplo-env-environ_mine",
    compose: "services:\n  web:\n    image: nginx\n    network_mode: host\n",
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("shop.example.com", "web", 80)],
    onWarn: (m) => warnings.push(m),
  });
  assert.match(warnings[0] ?? "", /will not answer/);
});

test("a top-level `networks:` that is not a map is replaced, not written onto", () => {
  // A list or a scalar made `yaml.dump` drop the key the renderer had just written,
  // so the stack shipped without its own network declared at all.
  for (const authored of ["networks: [x]", "networks: deplo"]) {
    const doc = networksOf(`${authored}\nservices:\n  a:\n    image: alpine\n`);
    assert.equal(doc.networks.deplo.name, "deplo-env-environ_mine");
  }
});

test("retargetStackNetwork points a stale stack file at today's network", () => {
  const stale =
    "services:\n  web:\n    image: nginx\n    networks: [deplo]\n" +
    "networks:\n  deplo:\n    name: deplo-env-environ_gone\n    external: true\n";
  const fixed = retargetStackNetwork(stale, "deplo-env-environ_now");
  assert.match(fixed, /name: deplo-env-environ_now/);
  assert.ok(!fixed.includes("environ_gone"));
  // Already right ⇒ byte-identical, so a restore recreates nothing for nothing.
  assert.equal(retargetStackNetwork(stale, "deplo-env-environ_gone"), stale);
});

test("composeEnvValues reads what the compose sets itself, both shapes", () => {
  const list = composeEnvValues(
    "services:\n  a:\n    environment:\n      - DATABASE_URL=postgres://db-shop:5432/x\n",
  );
  assert.equal(list.DATABASE_URL, "postgres://db-shop:5432/x");
  const map = composeEnvValues(
    "services:\n  a:\n    environment:\n      DB_HOST: db-shop\n",
  );
  assert.equal(map.DB_HOST, "db-shop");
});

test("naming your own networks does NOT take you off the Environment's", () => {
  // The regression this guards: reading "the author named the networks" as "leave
  // me alone" cut most stacks off from their own database, because organising
  // services into frontend/backend is what every non-trivial compose file does.
  const doc = networksOf(`
networks:
  appnet: {}
services:
  web:
    image: nginx
    networks: [appnet]
  api:
    image: nginx
    networks: [appnet]
`);
  assert.deepEqual(doc.services.web.networks, ["appnet", "deplo"]);
  assert.deepEqual(doc.services.api.networks, ["appnet", "deplo"]);
});

test("`internal: true` IS a deliberate isolation and is honoured", () => {
  const sealed = networksOf(`
networks:
  priv:
    internal: true
services:
  w:
    image: alpine
    networks: [priv]
`);
  assert.deepEqual(sealed.services.w.networks, ["priv"]);
  // Joining one sealed network and one open one is not being sealed off.
  const mixed = networksOf(`
networks:
  priv:
    internal: true
  pub: {}
services:
  w:
    image: alpine
    networks: [priv, pub]
`);
  assert.deepEqual(mixed.services.w.networks, ["priv", "pub", "deplo"]);
  // A plain `default: {}` is not an isolation - generators leave it everywhere.
  const plain = networksOf(`
networks:
  default: {}
services:
  w:
    image: alpine
`);
  assert.deepEqual(plain.services.w.networks, ["deplo"]);
});

test("a `hostname:` filled in from a variable is refused at the render", () => {
  // The value decides which name the container answers to on the network - `deplo`
  // is where the panel lives - and it arrives from the env-file, so no reading of
  // the authored text can see it. Refused like an interpolated network name.
  assert.throws(
    () =>
      buildComposeStack({
        network: "deplo-team-team_test",
        compose: "services:\n  web:\n    image: nginx\n    hostname: ${H}\n",
        name: "deplo-demo",
        deployKey: "demo",
        appId: "p1",
        domainRoutes: [],
      }),
    /filled in from a variable/,
  );
});

test("`internal: yes` seals a network too - compose reads it as true", () => {
  // The renderer parses YAML 1.2, where `yes` is the STRING "yes"; compose decodes
  // it into a bool. Reading only `=== true` handed a deliberately sealed service
  // its Environment's network back, egress included.
  const sealed = networksOf(`
networks:
  priv:
    internal: yes
services:
  w:
    image: alpine
    networks: [priv]
`);
  assert.deepEqual(sealed.services.w.networks, ["priv"]);
});

test("composeNamesOnNetwork agrees with what the render puts on the network", () => {
  // The two drifting apart is what made the clash guard refuse a move over a
  // `postgres` that never joins, naming a container that is not there.
  const cases = [
    "services:\n  web:\n    image: n\n  worker:\n    image: a\n",
    "services:\n  postgres:\n    image: p\n  web:\n    image: n\n",
    "services:\n  vpn:\n    image: v\n    network_mode: host\n  web:\n    image: n\n",
    "services:\n  side:\n    image: s\n    hostname: traefik\n  web:\n    image: n\n",
    "networks:\n  priv:\n    internal: true\nservices:\n  w:\n    image: a\n    networks: [priv]\n",
    "networks:\n  appnet: {}\nservices:\n  web:\n    image: n\n    networks: [appnet]\n",
  ];
  for (const compose of cases) {
    const rendered = buildComposeStack({
      network: "deplo-env-environ_mine",
      compose,
      name: "deplo-demo",
      deployKey: "demo",
      appId: "p1",
      domainRoutes: [],
    });
    assert.deepEqual(
      composeNamesOnNetwork(compose).sort(),
      stackNamesOnNetwork(rendered).sort(),
      compose,
    );
  }
});

test("a reserved name never breaks an `internal: true` seal", () => {
  // The regression: the `default` injected to reunite a stack around a reserved
  // name reached the sealed service too, and `default` is a NAT bridge - so a
  // worker the author had deliberately cut off got its internet egress back
  // because a `postgres` happened to sit in the same file.
  const sealed = `
networks:
  sealed:
    internal: true
services:
  worker:
    image: alpine
    networks: [sealed]
`;
  assert.deepEqual(networksOf(sealed).services.worker.networks, ["sealed"]);
  const withReserved = networksOf(
    `${sealed}  postgres:\n    image: postgres:16\n`,
  );
  assert.deepEqual(withReserved.services.worker.networks, ["sealed"]);
  assert.deepEqual(withReserved.services.postgres.networks, ["default"]);
});

test("a network name filled in from a variable is refused", () => {
  // The same hole `network_mode` had, on the other key: `sharedNetworkKeys`
  // resolves by NAME, so an interpolated one is invisible to the collapse, to the
  // clash guard and to the cross-network warning alike.
  for (const value of ["${TARGET}", "$TARGET"])
    assert.throws(
      () =>
        networksOf(
          `networks:\n  x:\n    external: true\n    name: "${value}"\nservices:\n  a:\n    image: n\n    networks: [x]\n`,
        ),
      /takes its name from a variable/,
      value,
    );
  // `external: {name: …}` is the same thing spelled differently.
  assert.throws(
    () =>
      networksOf(
        'networks:\n  x:\n    external:\n      name: "${T}"\nservices:\n  a:\n    image: n\n',
      ),
    /takes its name from a variable/,
  );
  assert.doesNotThrow(() =>
    networksOf(
      "networks:\n  x:\n    external: true\n    name: my-own-net\nservices:\n  a:\n    image: n\n    networks: [x]\n",
    ),
  );
});

test("network_mode may not join another container's namespace", () => {
  // `container:deplo-traefik` lands inside the proxy, which sits on every tenant
  // network of the host - the same reach as naming one of those networks.
  assert.throws(
    () =>
      networksOf(
        'services:\n  a:\n    image: n\n    network_mode: "container:deplo-traefik"\n',
      ),
    /another container's network namespace/,
  );
  // `service:` is compose's own same-file form and stays behind the host grant.
  assert.doesNotThrow(() =>
    networksOf(
      'services:\n  a:\n    image: n\n    network_mode: "service:b"\n  b:\n    image: n\n',
    ),
  );
});

test("a service kept off the network says so, route and all", () => {
  const warnings: string[] = [];
  buildComposeStack({
    network: "deplo-env-environ_mine",
    compose:
      "services:\n  postgres:\n    image: postgres:16\n  web:\n    image: nginx\n",
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("db.example.com", "postgres", 5432)],
    onWarn: (m) => warnings.push(m),
  });
  // One for the dead route, one for the service being kept off.
  assert.ok(warnings.some((w) => w.includes("will not answer")));
  assert.ok(
    warnings.some((w) => w.includes("kept off this environment's network")),
  );
});

test("a service whose name a neighbour already answers to stays off the network", () => {
  // Measured in production: two stacks in one environment both had a `db`, both
  // registered it on the shared network, and Docker round-robined them - so
  // paperless spent 106 restarts querying wordpress's database.
  const warnings: string[] = [];
  const doc = networksOf(
    "services:\n  webserver:\n    image: p\n  db:\n    image: postgres:16\n  broker:\n    image: redis\n",
    { takenNames: ["db"], onWarn: (m: string) => warnings.push(m) },
  );
  // Kept off the shared network, still reachable from its own stack.
  assert.deepEqual(doc.services.db.networks, ["default"]);
  assert.deepEqual(doc.services.webserver.networks, ["default", "deplo"]);
  assert.deepEqual(doc.services.broker.networks, ["default", "deplo"]);
  assert.ok(
    warnings.some((w) => w.includes("already answered by another stack")),
  );
});

test("a preview has no neighbours, so production's names hold nothing back", () => {
  // A preview is sealed in a network of its own (ADR-0028). Judging its services
  // against the names taken on the app's OWN network kept `db` off a network nobody
  // else is on, warned about a clash that cannot happen, and gave the stack a second
  // network to carry it.
  const warnings: string[] = [];
  const doc = networksOf(
    "services:\n  web:\n    image: n\n  db:\n    image: postgres:16\n",
    {
      network: "deplo-preview-shop__pr-42",
      takenNames: ["db"],
      onWarn: (m: string) => warnings.push(m),
    },
  );
  assert.deepEqual(doc.services.db.networks, ["deplo"]);
  assert.deepEqual(doc.services.web.networks, ["deplo"]);
  assert.deepEqual(warnings, []);
});

test("an unclaimed name still joins, so nothing is held back for nothing", () => {
  const doc = networksOf(
    "services:\n  web:\n    image: n\n  cache:\n    image: r\n",
    { takenNames: ["db", "postgres"] },
  );
  assert.deepEqual(doc.services.web.networks, ["deplo"]);
  assert.deepEqual(doc.services.cache.networks, ["deplo"]);
});
