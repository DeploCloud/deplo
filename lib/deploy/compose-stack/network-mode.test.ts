import { test } from "node:test";
import assert from "node:assert/strict";

import { buildComposeStack } from "./render";
import { buildDoc, labelsOf, networksOf, route } from "./stack-test-helpers";

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
        route("demo.1.2.3.4.deplo.site", "web", 80),
        route("agent.1.2.3.4.deplo.site", "agent", 8123),
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
    ["traefik.enable=false"],
  );
  assert.ok((doc.services.web.networks as string[]).includes("deplo"));
  assert.ok(
    labelsOf(doc.services.web).some((l) =>
      l.includes("Host(`demo.1.2.3.4.deplo.site`)"),
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
    { domainRoutes: [route("ha.1.2.3.4.deplo.site", "homeassistant", 8123)] },
  );
  assert.equal(doc.services.homeassistant.networks, undefined);
  assert.deepEqual(
    labelsOf(doc.services.homeassistant).filter((l) =>
      l.startsWith("traefik."),
    ),
    ["traefik.enable=false"],
  );
});

test("network_mode is refused for `$VAR` without braces too", () => {
  for (const mode of ["${NET}", "$NET", "$NET-suffix", "$(NET)"])
    assert.throws(
      () =>
        networksOf(
          `services:\n  s:\n    image: a\n    network_mode: "${mode}"\n`,
        ),
      /filled in from a variable/,
      mode,
    );
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

test("network_mode may not name a network Deplo manages", () => {
  const render = (mode: string) =>
    networksOf(
      `services:\n  s:\n    image: alpine\n    network_mode: ${mode}\n`,
    );
  for (const mode of [
    "deplo",
    "deplo-internal",
    "traefik_deplo-socket",
    "deplo-env-environ_victim",
    "deplo-team-team_victim",
  ])
    assert.throws(() => render(mode), /names a network Deplo manages/, mode);
  assert.throws(() => render("${DEPLO_NET}"), /filled in from a variable/);
  for (const mode of ["none", "host", "service:sibling"])
    assert.doesNotThrow(() => render(mode), mode);
});

test("network_mode may not join another container's namespace", () => {
  assert.throws(
    () =>
      networksOf(
        'services:\n  a:\n    image: n\n    network_mode: "container:deplo-traefik"\n',
      ),
    /another container's network namespace/,
  );
  assert.doesNotThrow(() =>
    networksOf(
      'services:\n  a:\n    image: n\n    network_mode: "service:b"\n  b:\n    image: n\n',
    ),
  );
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
