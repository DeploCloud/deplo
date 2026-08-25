import { test } from "node:test";
import assert from "node:assert/strict";

import { renderCompose, parseStackVolumes } from "./build";
import { buildComposeStack } from "./compose-stack";
import { previewDeployKey } from "./deploy-key";
import type { RoutableDomain } from "../data/domains";

/**
 * The load-bearing property of the deploy key: a PRODUCTION render is
 * byte-identical to what it has always been (the key is the app slug), while a
 * pull request preview shares nothing with it, not the container, not a volume,
 */

const ROUTE: RoutableDomain = {
  name: "blog.example.com",
  port: null,
  entrypoint: "websecure",
  tls: true,
  certResolver: "letsencrypt",
  middlewares: [],
  pathPrefix: "",
  stripPrefix: false,
  service: null,
  redirectTo: "",
};

const BASE = {
  image: "deplo/blog:abc",
  port: 3000,
  appId: "prj_1",
  routes: [ROUTE],
  env: { FOO: "bar" },
  // A named volume AND an `app` (files-dir) mount, so BOTH isolation axes -
  // the host volume name and the per-stack files dir - are exercised.
  volumes: [
    { name: "data", mountPath: "/app/data" },
    {
      type: "app" as const,
      name: "cfg",
      projectPath: "conf.yml",
      mountPath: "/etc/app.yml",
    },
  ],
};

test("a production render names everything after the app slug, and nothing else", () => {
  const yaml = renderCompose({
    ...BASE,
    name: "deplo-blog",
    deployKey: "blog",
  });
  assert.match(yaml, /container_name: deplo-blog\n/);
  assert.match(yaml, /name: deplo-blog-data/);
  assert.match(yaml, /files\/blog\//);
  assert.match(yaml, /deplo\.slug=blog/);
  assert.match(yaml, /deplo\.project=prj_1/);
  // The extra ownership label exists ONLY for previews. Emitting it here would
  // change every production stack's labels and force a needless restart.
  assert.doesNotMatch(yaml, /deplo\.app=/);
});

test("omitting trackingId is byte-identical to passing the app id", () => {
  const implicit = renderCompose({
    ...BASE,
    name: "deplo-blog",
    deployKey: "blog",
  });
  const explicit = renderCompose({
    ...BASE,
    name: "deplo-blog",
    deployKey: "blog",
    trackingId: "prj_1",
  });
  assert.equal(implicit, explicit);
});

test("a preview shares no container, volume or files dir with production", () => {
  const key = previewDeployKey("blog", 42);
  const yaml = renderCompose({
    ...BASE,
    name: `deplo-${key}`,
    deployKey: key,
    trackingId: "prv_1",
  });
  assert.match(yaml, /container_name: deplo-blog__pr-42\n/);
  assert.match(yaml, /name: deplo-blog__pr-42-data/);
  assert.match(yaml, /files\/blog__pr-42\//);
  // The production names must appear NOWHERE, not as a volume, not as a path.
  assert.doesNotMatch(yaml, /name: deplo-blog-data/);
  assert.doesNotMatch(yaml, /files\/blog\//);
  assert.doesNotMatch(yaml, /container_name: deplo-blog\n/);
});

test("a preview's telemetry label is its OWN id, with the app kept discoverable", () => {
  // The telemetry stream buckets container stats by `deplo.project`. Leaving the
  // app id there would let a preview's containers satisfy the app's live-status
  // check and land in its monitoring charts.
  const yaml = renderCompose({
    ...BASE,
    name: "deplo-blog__pr-42",
    deployKey: previewDeployKey("blog", 42),
    trackingId: "prv_1",
  });
  assert.match(yaml, /deplo\.project=prv_1/);
  assert.match(yaml, /deplo\.app=prj_1/);
  assert.doesNotMatch(yaml, /deplo\.project=prj_1/);
});

test("the reroute volume parser survives a __ in the key", () => {
  // parseStackVolumes strips exactly one path segment after `files/`; a preview
  // key contains `__`, and the round-trip must not lose it.
  const key = previewDeployKey("blog", 42);
  const yaml = renderCompose({
    ...BASE,
    name: `deplo-${key}`,
    deployKey: key,
  });
  const parsed = parseStackVolumes(yaml, `deplo-${key}`);
  // The named volume comes back plain; the `app` mount comes back with its
  // projectPath intact, which is the part the `__` could have eaten.
  assert.deepEqual(parsed, [
    { name: "data", mountPath: "/app/data", readOnly: false },
    {
      type: "app",
      name: "",
      projectPath: "conf.yml",
      mountPath: "/etc/app.yml",
      readOnly: false,
    },
  ]);
});

test("a compose stack isolates its volumes and labels the same way", () => {
  const compose = `services:\n  web:\n    image: nginx\n`;
  const production = buildComposeStack({
    compose,
    name: "deplo-blog",
    deployKey: "blog",
    appId: "prj_1",
    domainRoutes: [],
    volumes: [
      { id: "vol_1", name: "data", mountPath: "/data", readOnly: false },
    ],
  });
  assert.match(production, /deplo-blog-data/);
  assert.match(production, /deplo\.project=prj_1/);
  assert.doesNotMatch(production, /deplo\.app=/);

  const key = previewDeployKey("blog", 42);
  const preview = buildComposeStack({
    compose,
    name: `deplo-${key}`,
    deployKey: key,
    appId: "prj_1",
    trackingId: "prv_1",
    domainRoutes: [],
    volumes: [
      { id: "vol_1", name: "data", mountPath: "/data", readOnly: false },
    ],
  });
  assert.match(preview, /deplo-blog__pr-42-data/);
  assert.doesNotMatch(preview, /deplo-blog-data/);
  assert.match(preview, /deplo\.project=prv_1/);
  assert.match(preview, /deplo\.app=prj_1/);
});

/* ------------------------------------------------------------------ */
/* A compose preview must actually be reachable                        */
/* ------------------------------------------------------------------ */

const COMPOSE = `
services:
  web:
    image: nginx
    ports: ["8080:80"]
  worker:
    image: busybox
`;

/**
 * `buildComposeStack` skips every route that names no service, so a preview route
 * built with `service: null` produced a stack with NO Traefik router at all.
 */
test("a compose preview emits a router that names a service", () => {
  const key = previewDeployKey("blog", 42);
  const yaml = buildComposeStack({
    compose: COMPOSE,
    name: `deplo-${key}`,
    deployKey: key,
    stripPublishedPorts: true,
    appId: "prj_1",
    trackingId: "prv_1",
    domainRoutes: [
      {
        name: "blog-pr-42-abc-0a000001.nip.io",
        // What previewRouteTarget resolves from the app's primary domain.
        service: "web",
        port: 80,
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });

  assert.ok(
    yaml.includes("traefik.enable=true") ||
      yaml.includes("traefik.http.routers."),
    "the preview must carry Traefik router labels, or nobody can reach it",
  );
  assert.ok(
    yaml.includes("blog-pr-42-abc-0a000001.nip.io"),
    "the router must answer on the preview's own host",
  );
});

test("a serviceless route is exactly what used to make it unreachable", () => {
  // The regression, spelled out: same stack, route with no service ⇒ no router.
  // Kept so nobody "simplifies" previewRouteTarget back to passing null.
  const key = previewDeployKey("blog", 43);
  const yaml = buildComposeStack({
    compose: COMPOSE,
    name: `deplo-${key}`,
    deployKey: key,
    stripPublishedPorts: true,
    appId: "prj_1",
    trackingId: "prv_2",
    domainRoutes: [
      {
        name: "blog-pr-43-abc-0a000001.nip.io",
        service: null,
        port: null,
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  assert.ok(
    !yaml.includes("blog-pr-43-abc-0a000001.nip.io"),
    "a serviceless route wires nothing - this is the bug previewRouteTarget exists to prevent",
  );
});

test("a preview publishes no host ports, so two of them can coexist", () => {
  const key = previewDeployKey("blog", 44);
  const yaml = buildComposeStack({
    compose: COMPOSE,
    name: `deplo-${key}`,
    deployKey: key,
    stripPublishedPorts: true,
    appId: "prj_1",
    trackingId: "prv_3",
    domainRoutes: [
      {
        name: "h.nip.io",
        service: "web",
        port: 80,
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  assert.ok(
    !yaml.includes("8080:80"),
    "an inherited host port would make the second preview fail to start",
  );
});
