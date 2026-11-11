import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDocument } from "yaml";

import {
  appTunnelIngress,
  appTunnelService,
  hasTunnelConnector,
  panelTunnelToken,
  TUNNEL_SERVICE,
  withPanelTunnel,
  withTunnelConnector,
} from "./panel-tunnel-stack";
import { appConnectorService, withAppConnector } from "./app-connector";
import { MASKED, redactComposeForDisplay } from "./compose-redact";
import { domainScheme, domainTlsConfig } from "./domains";

const STACK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
networks:
  deplo:
    external: true
`;

test("an app tunnel hands every hostname to the proxy once, then answers 404", () => {
  assert.deepEqual(
    appTunnelIngress(["b.example.com", "A.example.com", "b.example.com"]),
    [
      { hostname: "a.example.com", service: "http://deplo-traefik:80" },
      { hostname: "b.example.com", service: "http://deplo-traefik:80" },
      { service: "http_status:404" },
    ],
  );
  assert.deepEqual(appTunnelIngress([]), [{ service: "http_status:404" }]);
});

test("each provider's connector sits beside the proxy under its own name", () => {
  const svc = appTunnelService("dnsp_AbC-123");
  assert.equal(svc, "deplo-dns-tunnel-dnspabc123");
  const yaml = withTunnelConnector(STACK, svc, "tok123");
  const doc = parseDocument(yaml).toJS();
  assert.equal(doc.services[svc].container_name, svc);
  assert.deepEqual(doc.services[svc].networks, ["deplo"]);
  assert.ok(doc.services.traefik, "the proxy stays");
  assert.ok(hasTunnelConnector(yaml, svc));
  assert.equal(
    panelTunnelToken(yaml),
    null,
    "the panel's connector is not touched",
  );

  const both = withPanelTunnel(yaml, "paneltok");
  assert.equal(panelTunnelToken(both), "paneltok");
  const without = withTunnelConnector(both, svc, null);
  assert.ok(!hasTunnelConnector(without, svc));
  assert.ok(
    hasTunnelConnector(without, TUNNEL_SERVICE),
    "removing one keeps the other",
  );
});

test("a tunnel domain routes plain HTTP on web, whatever its certificate says", () => {
  assert.deepEqual(
    domainTlsConfig({ certProvider: "cloudflare", tunnel: true }),
    { entrypoint: "web", tls: false, certResolver: "" },
  );
  assert.equal(
    domainScheme({ certProvider: "cloudflare", proxied: true }),
    "https",
    "its public address is still https",
  );
});

const APP_STACK = `services:
  deplo-web:
    image: deplo/web:1
    networks:
      - deplo
networks:
  deplo:
    name: deplo-env-environ_1
    external: true
`;

test("an App's own connector rides in its stack, on its network, marked to start after the App", () => {
  const out = withAppConnector(APP_STACK, "web", "tok_ABC-123");
  const doc = parseDocument(out).toJS() as {
    services: Record<string, Record<string, unknown>>;
    networks: Record<string, unknown>;
  };
  const name = appConnectorService("web");
  assert.equal(name, "deplo-connector_web");
  assert.deepEqual(Object.keys(doc.services), ["deplo-web", name]);
  const connector = doc.services[name];
  assert.deepEqual(connector.environment, ["TUNNEL_TOKEN=tok_ABC-123"]);
  assert.deepEqual(connector.labels, { "deplo.start-after-ready": "true" });
  // The stack's one network is the Environment's, where the proxy answers by name.
  assert.deepEqual(connector.networks, ["deplo"]);
  assert.deepEqual(doc.networks, {
    deplo: { name: "deplo-env-environ_1", external: true },
  });
  assert.equal(withAppConnector(out, "web", "tok_ABC-123"), out);

  // A server's proxy starts its connector with the proxy: nothing to wait for there.
  const proxy = parseDocument(
    withTunnelConnector(STACK, "deplo-dns-tunnel-x", "tok"),
  ).toJS() as { services: Record<string, Record<string, unknown>> };
  assert.equal(proxy.services["deplo-dns-tunnel-x"].labels, undefined);
});

test("the run token is masked in a stack shown to a user", () => {
  const shown = redactComposeForDisplay(
    withAppConnector(APP_STACK, "web", "tok_ABC-123"),
  );
  assert.doesNotMatch(shown, /tok_ABC-123/);
  assert.match(shown, new RegExp(`TUNNEL_TOKEN=${MASKED}`));
  assert.match(shown, /deplo\.start-after-ready: "true"/);
});
