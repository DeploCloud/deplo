import { test } from "node:test";
import assert from "node:assert/strict";

import { composeNamesOnNetwork } from "./compose-read";
import { buildComposeStack } from "./render";
import { retargetStackNetwork, stackNamesOnNetwork } from "./stack-network";
import { buildDoc, networksOf, route } from "./stack-test-helpers";

test("a hand-written alias on the shared network does not survive the render", () => {
  const out = buildComposeStack({
    network: "deplo-team-team_test",
    compose: `services:
  web:
    image: nginx
    networks:
      deplo:
        aliases: [postgres, Deplo]
networks:
  deplo: {external: true}`,
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [],
  });
  assert.ok(!out.includes("aliases"), `an alias survived:\n${out}`);
});

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

test("the shared network is resolved by NAME, not by the key it is given", () => {
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

test("a `default` pointed at another tenant's network is collapsed, not honoured", () => {
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
  assert.deepEqual(Object.keys(doc.networks), ["deplo"]);
});

test("the author's own `default` is honoured, not overridden", () => {
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
  assert.deepEqual(stackNamesOnNetwork(rendered).sort(), [
    "api",
    "sidecar",
    "web",
  ]);
});

test("a top-level `networks:` that is not a map is replaced, not written onto", () => {
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
  assert.equal(retargetStackNetwork(stale, "deplo-env-environ_gone"), stale);
});

test("naming your own networks does NOT take you off the Environment's", () => {
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
  const plain = networksOf(`
networks:
  default: {}
services:
  w:
    image: alpine
`);
  assert.deepEqual(plain.services.w.networks, ["deplo"]);
});

test("`internal: yes` seals a network too - compose reads it as true", () => {
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

test("a network name filled in from a variable is refused", () => {
  for (const value of ["${TARGET}", "$TARGET"])
    assert.throws(
      () =>
        networksOf(
          `networks:\n  x:\n    external: true\n    name: "${value}"\nservices:\n  a:\n    image: n\n    networks: [x]\n`,
        ),
      /takes its name from a variable/,
      value,
    );
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
