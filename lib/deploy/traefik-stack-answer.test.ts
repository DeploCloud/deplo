import { test } from "node:test";
import assert from "node:assert/strict";

import * as yaml from "js-yaml";

import { hasAnswerSupport, withAnswerSupport } from "./traefik-cluster";
import { INSTALLED_WITH_PANEL, parse } from "./traefik-stack-test-helpers";

// What install-agent.sh writes on a server: no file provider, no configs.
const INSTALLED = `services:
  traefik:
    image: traefik:v3.7.17
    container_name: deplo-traefik
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.endpoint=tcp://deplo-socket-proxy:2375
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=deplo
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.web.http.redirections.entrypoint.priority=1
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /opt/deplo-agent/traefik/acme:/acme
    networks:
      - deplo
      - deplo-socket
`;

type Proxy = {
  command: string[];
  volumes?: string[];
  ports?: string[];
  configs?: { source: string; target: string }[];
};
const proxyOf = (s: string) => parse(s).services.traefik as unknown as Proxy;
const fileOf = (s: string) =>
  yaml.load(
    (parse(s).configs as Record<string, { content: string }>)["deplo-answer"]
      .content,
  ) as {
    http: { routers: Record<string, Record<string, unknown>> };
    tcp: { serversTransports: Record<string, unknown> };
  };

test("the change adds the loopback entrypoint, the bypass on web, Deplo's file and the routes file", () => {
  const on = withAnswerSupport(INSTALLED, true);
  const proxy = proxyOf(on);
  for (const flag of [
    "--entrypoints.web.allowacmebypass=true",
    "--entrypoints.answer.address=127.0.0.1:8443",
    "--entrypoints.answer.proxyprotocol.trustedips=127.0.0.1/32",
    "--providers.file.directory=/deplo-dynamic",
    "--providers.file.watch=true",
  ])
    assert.ok(proxy.command.includes(flag), flag);
  // Nothing new is published, and websecure trusts no PROXY header.
  assert.deepEqual(proxy.ports, ["80:80", "443:443"]);
  assert.ok(
    !proxy.command.some((c) =>
      c.startsWith("--entrypoints.websecure.proxyprotocol"),
    ),
  );
  assert.ok(!proxy.command.some((c) => /http3/.test(c)));
  assert.ok(
    proxy.volumes?.includes(
      "./answers.yml:/deplo-dynamic/deplo-answers.yml:ro",
    ),
  );
  assert.deepEqual(fileOf(on), {
    http: {
      routers: {
        "deplo-acme": {
          rule: "PathPrefix(`/.well-known/acme-challenge/`)",
          entryPoints: ["web", "answer"],
          service: "acme-http@internal",
          priority: 2000000000,
        },
      },
    },
    tcp: {
      serversTransports: {
        "deplo-answer": { proxyProtocol: { version: 2 } },
      },
    },
  });
  assert.ok(hasAnswerSupport(on));
  assert.equal(withAnswerSupport(on, true), on);
});

// A server that stops using it is left exactly as it was, so it is as if it never had it.
test("taking the change out gives back the stack as it was", () => {
  for (const stack of [INSTALLED, INSTALLED_WITH_PANEL]) {
    assert.ok(!hasAnswerSupport(stack));
    const back = withAnswerSupport(withAnswerSupport(stack, true), false);
    assert.deepEqual(parse(back), parse(stack));
    assert.ok(!hasAnswerSupport(back));
  }
});

test("beside the panel's own file, the routes file joins the same directory and the panel's file stays", () => {
  const on = withAnswerSupport(INSTALLED_WITH_PANEL, true);
  const proxy = proxyOf(on);
  assert.ok(proxy.configs?.some((c) => c.source === "deplo-panel"));
  assert.ok(
    proxy.configs?.some(
      (c) =>
        c.source === "deplo-answer" &&
        c.target === "/deplo-dynamic/deplo-answer.yml",
    ),
  );
  assert.equal(
    proxy.command.filter((c) => c.startsWith("--providers.file.directory="))
      .length,
    1,
  );
});

test("a proxy whose checks arrive on another entrypoint gets the bypass there", () => {
  const custom = INSTALLED.replace(
    "httpchallenge.entrypoint=web",
    "httpchallenge.entrypoint=http",
  );
  const on = withAnswerSupport(custom, true);
  assert.ok(
    proxyOf(on).command.includes("--entrypoints.http.allowacmebypass=true"),
  );
  assert.ok(
    !proxyOf(on).command.includes("--entrypoints.web.allowacmebypass=true"),
  );
  assert.deepEqual(fileOf(on).http.routers["deplo-acme"]!.entryPoints, [
    "http",
    "answer",
  ]);
});
