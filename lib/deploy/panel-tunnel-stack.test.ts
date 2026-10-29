import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "yaml";

import {
  CLOUDFLARED_IMAGE,
  TUNNEL_SERVICE,
  panelTunnelIngress,
  panelTunnelToken,
  withPanelTunnel,
} from "./panel-tunnel-stack";
import { panelRoute, withPanelRoute } from "./traefik-stack";

const STACK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
    networks:
      - deplo
      - deplo-socket
  deplo-socket-proxy:
    image: tecnativa/docker-socket-proxy:v0.5.0
    networks:
      - deplo-socket
networks:
  deplo:
    external: true
  deplo-socket:
    internal: true
`;

const TOKEN = "eyJhIjoiYWNjdCIsInQiOiJ0dW4iLCJzIjoic2VjcmV0In0=";

type Compose = {
  services: Record<string, Record<string, unknown>>;
  networks: Record<string, unknown>;
};

test("the connector joins the panel's own network, with the token and a pinned image", () => {
  const doc = parse(withPanelTunnel(STACK, TOKEN)) as Compose;
  const svc = doc.services[TUNNEL_SERVICE];
  assert.equal(svc.image, CLOUDFLARED_IMAGE);
  assert.match(CLOUDFLARED_IMAGE, /:\d{4}\.\d+\.\d+$/, "never :latest");
  assert.deepEqual(
    svc.networks,
    ["deplo"],
    "no tenant network, and not the socket's",
  );
  assert.deepEqual(svc.command, ["tunnel", "--no-autoupdate", "run"]);
  assert.deepEqual(svc.environment, [`TUNNEL_TOKEN=${TOKEN}`]);
  assert.equal(svc.restart, "unless-stopped");
  assert.ok(svc.logging, "its logs are capped like every other service");
  assert.deepEqual(
    Object.keys(doc.services),
    ["traefik", "deplo-socket-proxy", TUNNEL_SERVICE],
    "the proxy's own services are left alone",
  );
  assert.equal(panelTunnelToken(withPanelTunnel(STACK, TOKEN)), TOKEN);
});

test("turning it off removes the connector and nothing else", () => {
  const on = withPanelTunnel(STACK, TOKEN);
  const off = withPanelTunnel(on, null);
  assert.equal(panelTunnelToken(off), null);
  assert.deepEqual(parse(off), parse(STACK));
  assert.deepEqual(parse(withPanelTunnel(STACK, null)), parse(STACK));
});

test("writing it twice replaces the token rather than adding a second connector", () => {
  const twice = withPanelTunnel(withPanelTunnel(STACK, TOKEN), "b3RoZXI=");
  assert.equal(panelTunnelToken(twice), "b3RoZXI=");
  assert.deepEqual(Object.keys((parse(twice) as Compose).services), [
    "traefik",
    "deplo-socket-proxy",
    TUNNEL_SERVICE,
  ]);
});

test("a stack with no platform network declared gets one", () => {
  const bare = `services:\n  traefik:\n    image: traefik:v3.7\n`;
  const doc = parse(withPanelTunnel(bare, TOKEN)) as Compose;
  assert.deepEqual(doc.networks.deplo, { external: true });
});

test("a token that could break out of the YAML line is refused", () => {
  for (const bad of ["abc\ndef", "abc def", "abc'", "${HOME}", ""])
    assert.throws(() => withPanelTunnel(STACK, bad), /token Deplo cannot use/);
});

test("the panel's own route edits keep the connector", () => {
  const route = {
    domain: "deplo.example.com",
    fallbackDomain: "deplo-cb00710a.deplo.site",
    https: true,
    certResolver: null,
    target: "http://deplo:3000",
  };
  const both = withPanelRoute(withPanelTunnel(STACK, TOKEN), route);
  assert.equal(panelTunnelToken(both), TOKEN);
  assert.deepEqual(panelRoute(both), route);
});

test("the tunnel routes the link door to the link listener, then the panel, then nothing", () => {
  assert.deepEqual(
    panelTunnelIngress("deplo.example.com", "http://deplo:3000"),
    [
      {
        hostname: "deplo.example.com",
        path: "^/api/agent/link$",
        service: "http://deplo:3001",
      },
      { hostname: "deplo.example.com", service: "http://deplo:3000" },
      { service: "http_status:404" },
    ],
  );
  assert.equal(
    panelTunnelIngress("deplo.example.com", "http://panel.internal:4000")[0]
      .service,
    "http://panel.internal:3001",
    "the link listener sits beside wherever the proxy reaches the panel",
  );
});
