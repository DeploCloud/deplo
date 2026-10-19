import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeTraefikLabels,
  overlayTraefikLabels,
  validateTraefikLabels,
} from "./traefik-overrides";
import { buildDoc, labelsOf } from "./compose-stack/stack-test-helpers";
import { renderCompose } from "./build/compose-render";

const generated = [
  "deplo.project=app1",
  "traefik.enable=true",
  "traefik.docker.network=tenant",
  "traefik.http.routers.auto.rule=Host(`auto.test`)",
  "traefik.http.routers.auto.entrypoints=websecure",
  "traefik.http.routers.auto.tls.certresolver=letsencrypt",
  "traefik.http.services.auto.loadbalancer.server.port=80",
];
const manual = [
  {
    key: "traefik.http.routers.headscale.rule",
    value: "Host(`hs.example.test`)",
  },
  { key: "traefik.http.routers.headscale.entrypoints", value: "websecure" },
  {
    key: "traefik.http.routers.headscale.tls.certresolver",
    value: "letsencrypt",
  },
  {
    key: "traefik.http.services.headscale.loadbalancer.server.port",
    value: "8080",
  },
];

test("an app without overrides retains byte-identical labels", () => {
  assert.deepEqual(overlayTraefikLabels(generated, []), generated);
});

test("an exact key override keeps all unspecified defaults", () => {
  const out = overlayTraefikLabels(generated, [
    { key: "TRAEFIK.HTTP.ROUTERS.AUTO.rule", value: "Host(`changed.test`)" },
  ]);
  assert.ok(
    out.includes("TRAEFIK.HTTP.ROUTERS.AUTO.rule=Host(`changed.test`)"),
  );
  assert.ok(out.includes(generated[4]));
  assert.ok(out.includes(generated[6]));
  assert.equal(out.length, generated.length);
});

test("a complete custom route replaces generated routing but keeps tracking and network", () => {
  const out = overlayTraefikLabels(generated, manual);
  assert.ok(!out.some((label) => label.includes(".auto.")));
  assert.ok(out.includes("deplo.project=app1"));
  assert.ok(out.includes("traefik.docker.network=tenant"));
  for (const label of manual)
    assert.ok(out.includes(`${label.key}=${label.value}`));
});

test("all header fields and middleware kinds are preserved and attached", () => {
  const labels = [
    {
      key: "traefik.http.middlewares.cors.headers.accessControlAllowOriginList",
      value: "https://hp.example.test",
    },
    {
      key: "traefik.http.middlewares.auth.forwardauth.address",
      value: "http://auth:8080",
    },
    {
      key: "traefik.http.middlewares.auth.forwardauth.authResponseHeaders",
      value: "X-User,X-Team",
    },
    {
      key: "traefik.http.middlewares.cors.headers.customResponseHeaders.X-Custom",
      value: "a=b",
    },
  ];
  const out = overlayTraefikLabels(generated, labels);
  assert.ok(out.includes("traefik.http.routers.auto.middlewares=cors,auth"));
  assert.ok(
    out.includes(
      "traefik.http.middlewares.cors.headers.customResponseHeaders.X-Custom=a=b",
    ),
  );
});

test("explicit middleware and enable overrides win over defaults", () => {
  const out = overlayTraefikLabels(generated, [
    ...manual,
    { key: "traefik.enable", value: "false" },
    { key: "traefik.http.routers.headscale.middlewares", value: "custom@file" },
  ]);
  assert.ok(out.includes("traefik.enable=false"));
  assert.ok(
    out.includes("traefik.http.routers.headscale.middlewares=custom@file"),
  );
});

for (const protocol of ["tcp", "udp"])
  test(`${protocol} custom routing is retained`, () => {
    const labels = [
      {
        key: `traefik.${protocol}.routers.custom.${protocol === "tcp" ? "rule" : "service"}`,
        value: protocol === "tcp" ? "HostSNI(`*`)" : "custom",
      },
      {
        key: `traefik.${protocol}.services.custom.loadbalancer.server.port`,
        value: "9000",
      },
    ];
    const out = overlayTraefikLabels(generated, labels);
    assert.ok(!out.some((label) => label.includes(".auto.")));
    assert.ok(out.includes(`${labels[1].key}=9000`));
  });

for (const key of [
  "traefik.web.routers.x.rule",
  "traefik.httpwebrouters.x.middlewares",
  "deplo.managed",
  "traefik.http.routers.${NAME}.rule",
])
  test(`invalid or reserved key is rejected: ${key}`, () =>
    assert.throws(() => validateTraefikLabels([{ key, value: "x" }])));

for (const value of ["${DOMAIN}", "$DOMAIN", "x\ny", "x\0y"])
  test(`unsafe label value is rejected: ${JSON.stringify(value)}`, () =>
    assert.throws(() =>
      validateTraefikLabels([{ key: "traefik.http.routers.x.rule", value }]),
    ));

test("literal escaped dollars survive, duplicates and oversized lists fail", () => {
  assert.equal(
    validateTraefikLabels([
      {
        key: "traefik.http.middlewares.auth.basicauth.users",
        value: "u:$$2y$$hash",
      },
    ])[0].value,
    "u:$$2y$$hash",
  );
  assert.throws(() =>
    validateTraefikLabels([
      { key: "traefik.enable", value: "true" },
      { key: "TRAEFIK.ENABLE", value: "false" },
    ]),
  );
  assert.throws(() =>
    validateTraefikLabels(
      Array.from({ length: 257 }, (_, i) => ({
        key: `traefik.http.middlewares.m.headers.x${i}`,
        value: "x",
      })),
    ),
  );
  assert.throws(() =>
    validateTraefikLabels([
      { key: "traefik.enable", value: "a".repeat(65537) },
    ]),
  );
});

for (const map of [false, true])
  test(`Compose custom routing respects service boundaries (${map ? "map" : "list"})`, () => {
    const labels = manual
      .map(({ key, value }) =>
        map ? `      ${key}: '${value}'` : `      - '${key}=${value}'`,
      )
      .join("\n");
    const compose = `services:\n  web:\n    image: nginx\n    labels:\n${labels}\n  api:\n    image: nginx\n`;
    assert.equal(composeTraefikLabels(compose).get("web")?.length, 4);
    const doc = buildDoc(compose, { allowTraefikLabels: true });
    const web = labelsOf(doc.services.web);
    assert.ok(
      web.includes(
        "traefik.http.routers.headscale.rule=Host(`hs.example.test`)",
      ),
    );
    assert.ok(
      !web.some(
        (label) =>
          label.includes("auto.test") ||
          label.includes("demo.1.2.3.4.deplo.site"),
      ),
    );
    assert.ok(
      !labelsOf(doc.services.api).some((label) => label.includes("headscale")),
    );
    const untrusted = labelsOf(buildDoc(compose).services.web);
    assert.ok(!untrusted.some((label) => label.includes("hs.example.test")));
  });

test("single-image routing uses the same override rules", () => {
  const out = renderCompose({
    name: "app",
    image: "nginx",
    appId: "app1",
    deployKey: "app",
    network: "tenant",
    port: 80,
    routes: [],
    env: {},
    traefikLabels: manual,
  });
  assert.match(out, /traefik.enable=true/);
  assert.match(out, /headscale/);
  assert.match(out, /deplo.project=app1/);
});

test("indexed labels and authored option names retain their spelling", () => {
  const labels = [
    {
      key: "traefik.http.routers.auto.tls.domains[0].main",
      value: "example.test",
    },
    {
      key: "traefik.http.middlewares.MyPlugin.plugin.Example.someOption[0]",
      value: "CaseSensitiveValue",
    },
  ];
  const out = overlayTraefikLabels(generated, labels);
  for (const label of labels)
    assert.ok(out.includes(`${label.key}=${label.value}`));
  assert.ok(out.includes("traefik.http.routers.auto.middlewares=MyPlugin"));
});

test("partial backend overrides retain generated routes and ports", () => {
  const out = overlayTraefikLabels(generated, [
    { key: "traefik.http.routers.alias.rule", value: "Host(`alias.test`)" },
    {
      key: "traefik.http.services.auto.loadbalancer.passhostheader",
      value: "false",
    },
  ]);
  for (const entry of generated) assert.ok(out.includes(entry));
});

test("a complete backend for a different router does not take over", () => {
  const out = overlayTraefikLabels(generated, [
    { key: "traefik.http.routers.alias.rule", value: "Host(`alias.test`)" },
    { key: "traefik.http.routers.alias.service", value: "auto" },
    {
      key: "traefik.http.services.other.loadbalancer.server.port",
      value: "8080",
    },
  ]);
  for (const entry of generated) assert.ok(out.includes(entry));
});

test("disabling proxy routing does not require joining the proxy network", () => {
  const doc = buildDoc(
    "services:\n  web:\n    image: nginx\n    network_mode: host\n    labels:\n      traefik.enable: false\n",
    { allowTraefikLabels: true },
  );
  assert.ok(labelsOf(doc.services.web).includes("traefik.enable=false"));
});
