import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { renderCompose } from "../build/compose-render";
import { CR } from "./routing-test-helpers";

const AT = "traefik.http.services.deplo-web.loadbalancer.sticky.cookie";
const labels = (sticky?: boolean) =>
  traefikRouterLabels({
    baseKey: "deplo-web",
    routes: [{ name: "app.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
    sticky,
  });

test("the sticky cookie is in the labels only when asked for", () => {
  assert.ok(labels(true).includes(`${AT}=true`));
  assert.ok(!labels(false).some((l) => l.includes("sticky")));
  assert.ok(!labels().some((l) => l.includes("sticky")));
});

test("the cookie is secure and http-only on a tls router", () => {
  const l = labels(true);
  assert.ok(l.includes(`${AT}.secure=true`));
  assert.ok(l.includes(`${AT}.httponly=true`));
});

const render = (replicas: number, stickySessions: boolean) =>
  renderCompose({
    name: "web",
    image: "nginx",
    port: 80,
    appId: "prj_web",
    deployKey: "web",
    trackingId: "prj_web",
    network: "deplo-team-t",
    routes: [{ name: "app.com", port: null }],
    env: {},
    replicas,
    stickySessions,
  } as Parameters<typeof renderCompose>[0]);

test("a render carries the cookie only with the switch on and replicas > 1", () => {
  assert.match(render(3, true), /sticky\.cookie=true/);
  assert.doesNotMatch(render(1, true), /sticky/);
  assert.doesNotMatch(render(3, false), /sticky/);
});
