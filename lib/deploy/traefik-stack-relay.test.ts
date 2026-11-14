import { test } from "node:test";
import assert from "node:assert/strict";

import { panelRoute, withPanelRoute } from "./traefik-stack";
import {
  type Doc,
  INSTALLED_WITH_PANEL,
  PANEL_ROUTE,
  panelFileOf,
  parse,
} from "./traefik-stack-test-helpers";

const RELAY_ON = (host: string) =>
  `Host(\`${host}\`) && Path(\`/api/cluster/relay\`)`;

const proxyOf = (s: string) =>
  (parse(s) as Doc & { services: Record<string, { extra_hosts?: string[] }> })
    .services;

test("the cluster relay rides the panel's own names beside the link, to the relay on the host", () => {
  const on = withPanelRoute(INSTALLED_WITH_PANEL, {
    ...PANEL_ROUTE,
    relay: true,
  });
  const http = panelFileOf(on).http;
  assert.deepEqual(http.routers["deplo-panel-relay"], {
    rule: RELAY_ON("deplo.example.com"),
    entryPoints: ["websecure"],
    service: "deplo-relay",
    priority: 3,
    tls: { certResolver: "letsencrypt" },
  });
  assert.equal(
    http.routers["deplo-panel-fallback-relay"].rule,
    RELAY_ON("deplo-cb007109.deplo.site"),
  );
  assert.deepEqual(http.services["deplo-relay"], {
    loadBalancer: { servers: [{ url: "http://host.docker.internal:3002" }] },
  });
  for (const [name, router] of Object.entries(http.routers))
    assert.doesNotMatch(
      String(router.rule),
      /^Path/,
      `${name}: a bare path would take the relay's path from every app`,
    );
  // The proxy reaches a process on the host by Docker's gateway name.
  const traefik = Object.values(proxyOf(on)).find((s) => s.extra_hosts);
  assert.deepEqual(traefik?.extra_hosts, ["host.docker.internal:host-gateway"]);
  assert.equal(panelRoute(on)?.relay, true);
});

test("a panel without a relay route is unchanged byte for byte, and reads as having none", () => {
  const out = withPanelRoute(
    INSTALLED_WITH_PANEL,
    panelRoute(INSTALLED_WITH_PANEL)!,
  );
  const http = panelFileOf(out).http;
  assert.equal(http.routers["deplo-panel-relay"], undefined);
  assert.equal(http.services["deplo-relay"], undefined);
  assert.equal(panelRoute(out)?.relay, undefined);
  assert.ok(!Object.values(proxyOf(out)).some((s) => s.extra_hosts));
});

test("the relay route follows the panel's address, survives its edits, and goes when asked", () => {
  const on = withPanelRoute(INSTALLED_WITH_PANEL, {
    ...PANEL_ROUTE,
    relay: true,
  });
  const moved = withPanelRoute(on, {
    ...panelRoute(on)!,
    domain: "new.example.com",
  });
  assert.equal(
    panelFileOf(moved).http.routers["deplo-panel-relay"].rule,
    RELAY_ON("new.example.com"),
  );
  assert.equal(panelRoute(moved)?.relay, true, "an address move keeps it");

  const off = withPanelRoute(moved, { ...panelRoute(moved)!, relay: false });
  const http = panelFileOf(off).http;
  assert.equal(http.routers["deplo-panel-relay"], undefined);
  assert.equal(http.routers["deplo-panel-fallback-relay"], undefined);
  assert.equal(http.services["deplo-relay"], undefined);
  assert.ok(!Object.values(proxyOf(off)).some((s) => s.extra_hosts));

  const gone = withPanelRoute(on, null);
  assert.ok(!Object.values(proxyOf(gone)).some((s) => s.extra_hosts));
});

test("another entry the proxy already has in extra_hosts is kept when the relay comes and goes", () => {
  const withHost = INSTALLED_WITH_PANEL.replace(
    /(\n {4}container_name: deplo-traefik)/,
    '$1\n    extra_hosts:\n      - "metrics.internal:10.0.0.9"',
  );
  assert.match(withHost, /metrics\.internal/);
  const on = withPanelRoute(withHost, { ...PANEL_ROUTE, relay: true });
  const hosts = (s: string) =>
    Object.values(proxyOf(s)).find((x) => x.extra_hosts)?.extra_hosts;
  assert.deepEqual(hosts(on), [
    "metrics.internal:10.0.0.9",
    "host.docker.internal:host-gateway",
  ]);
  assert.deepEqual(
    hosts(withPanelRoute(on, { ...PANEL_ROUTE, relay: false })),
    ["metrics.internal:10.0.0.9"],
  );
});

test("a panel run on the host keeps the gateway name on the proxy with no relay route", () => {
  const onHost = { ...PANEL_ROUTE, target: "http://host.docker.internal:3000" };
  const routed = withPanelRoute(INSTALLED_WITH_PANEL, onHost);
  const hosts = (s: string) =>
    Object.values(proxyOf(s)).find((x) => x.extra_hosts)?.extra_hosts;
  assert.deepEqual(hosts(routed), ["host.docker.internal:host-gateway"]);
  assert.equal(panelRoute(routed)?.relay, undefined);
  assert.deepEqual(
    hosts(withPanelRoute(routed, { ...onHost, relay: true })),
    ["host.docker.internal:host-gateway"],
    "one entry, not two, once a relay comes",
  );
  assert.equal(
    hosts(withPanelRoute(routed, PANEL_ROUTE)),
    undefined,
    "and none once the panel is a container again",
  );
});
