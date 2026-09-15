import { test } from "node:test";
import assert from "node:assert/strict";

import { composeNeedsHostPrivileges } from "./host-privileges";
import { lintCompose } from "./lint";

test("composeNeedsHostPrivileges: network_mode host IS a privilege (H-3)", () => {
  const yaml = `services:\n  app:\n    image: nginx\n    network_mode: host`;
  assert.equal(composeNeedsHostPrivileges(yaml), true);
});

test("network_mode names a NETWORK unless it is a keyword, so it is allowlisted", () => {
  const mode = (v: string) =>
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    network_mode: ${v}`,
    );
  assert.equal(mode("none"), false);
  assert.equal(mode("default"), false);
  assert.equal(mode("bridge"), true);
  assert.equal(mode("deplo"), true);
  assert.equal(mode("traefik_deplo-socket"), true);
  assert.equal(mode("deplo-env-environ_victim"), true);
  assert.equal(mode("${DEPLO_NET}"), true);
  assert.equal(mode("host"), true);
  assert.equal(mode("container:other"), true);
});

test("every network_mode form warns that the service cannot be routed", () => {
  const of = (mode: string) =>
    lintCompose(
      `services:\n  side:\n    image: gluetun\n  web:\n    image: nginx\n    network_mode: "${mode}"\n`,
    ).filter((d) => d.rule === "network-mode-host");

  for (const mode of ["host", "service:side", "container:other"]) {
    const hits = of(mode);
    assert.equal(hits.length, 1, `${mode} produced no routing warning`);
    assert.match(hits[0].message, /won't work|out of Traefik's reach/);
  }
  assert.equal(
    lintCompose("services:\n  web:\n    image: nginx\n").filter(
      (d) => d.rule === "network-mode-host",
    ).length,
    0,
    "a service with no network_mode must not be warned about",
  );
});
