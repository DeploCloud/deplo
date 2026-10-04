import { test } from "node:test";
import assert from "node:assert/strict";

import { lintCompose } from "./lint";
import { readTraefikLabel } from "./traefik-labels";

test("only a middleware of a kind that touches the app's own traffic is kept", () => {
  const kinds = Object.fromEntries(
    [
      "traefik.http.middlewares.sec.headers.customresponseheaders.X-Foo",
      "traefik.http.middlewares.gz.compress",
      "traefik.http.middlewares.auth.basicauth.users",
      "traefik.http.middlewares.auth.basicauth.usersfile",
      "traefik.http.middlewares.rl.ratelimit.average",
      "traefik.http.middlewares.rl.ratelimit.redis.endpoints",
      "traefik.http.middlewares.fa.forwardauth.address",
      "traefik.http.middlewares.err.errors.service",
      "traefik.http.middlewares.ch.chain.middlewares",
      "traefik.http.middlewares.pl.plugin.foo.bar",
      "traefik.http.middlewares.bad@name.compress",
      "traefik.http.routers.app.rule",
      "traefik.http.services.app.loadbalancer.server.port",
      "traefik.tcp.routers.db.rule",
      "traefik.enable",
      "TRAEFIK.Docker.Network",
      "${LABEL}",
      "com.example.keep",
    ].map((k) => [k, readTraefikLabel(k).kind]),
  );
  assert.deepEqual(kinds, {
    "traefik.http.middlewares.sec.headers.customresponseheaders.X-Foo":
      "middleware",
    "traefik.http.middlewares.gz.compress": "middleware",
    "traefik.http.middlewares.auth.basicauth.users": "middleware",
    "traefik.http.middlewares.auth.basicauth.usersfile": "ignored",
    "traefik.http.middlewares.rl.ratelimit.average": "middleware",
    "traefik.http.middlewares.rl.ratelimit.redis.endpoints": "ignored",
    "traefik.http.middlewares.fa.forwardauth.address": "ignored",
    "traefik.http.middlewares.err.errors.service": "ignored",
    "traefik.http.middlewares.ch.chain.middlewares": "ignored",
    "traefik.http.middlewares.pl.plugin.foo.bar": "ignored",
    "traefik.http.middlewares.bad@name.compress": "ignored",
    "traefik.http.routers.app.rule": "ignored",
    "traefik.http.services.app.loadbalancer.server.port": "ignored",
    "traefik.tcp.routers.db.rule": "ignored",
    "traefik.enable": "owned",
    "TRAEFIK.Docker.Network": "owned",
    "${LABEL}": "ignored",
    "com.example.keep": "other",
  });
});

test("the editor warns about the Traefik labels a deploy would drop, and only those", () => {
  const diags = lintCompose(
    [
      "services:",
      "  web:",
      "    image: nginx:1.27",
      "    labels:",
      "      - traefik.enable=true",
      "      - traefik.http.middlewares.gz.compress=true",
      "      - traefik.http.routers.web.rule=Host(`acme.com`)",
      "  api:",
      "    image: nginx:1.27",
      "    labels:",
      "      traefik.enable: true",
      "      traefik.http.middlewares.sec.headers.framedeny: true",
    ].join("\n"),
  );
  const ignored = diags.filter((d) => d.rule === "traefik-label-ignored");
  assert.equal(ignored.length, 1, JSON.stringify(ignored));
  assert.equal(ignored[0].severity, "warning");
  assert.equal(ignored[0].line, 4);
  assert.match(ignored[0].message, /^`web`.*traefik\.http\.routers\.web\.rule/);
});
