import { test } from "node:test";
import assert from "node:assert/strict";

import { renderCompose, parseStackPorts, portMappings } from "./build";
import type { RoutableDomain } from "../data/domains";

/**
 * Published host ports on the single-container stack. NO ports ⇒ output
 * byte-identical to the long-standing stack, like volumes and resource limits.
 */

const route: RoutableDomain = {
  name: "demo.example.com",
  port: null,
  entrypoint: "websecure",
  tls: true,
  certResolver: "letsencrypt",
  middlewares: [],
  pathPrefix: "",
  stripPrefix: false,
  service: null,
  redirectTo: "",
};

const base = {
  network: "deplo-team-team_test",
  name: "deplo-demo",
  image: "deplo/demo:abc123",
  port: 3000,
  appId: "p1",
  deployKey: "demo",
  routes: [route],
  env: { FOO: "bar" },
};

test("no ports: output is byte-identical with [], undefined and no key", () => {
  const missing = renderCompose(base);
  assert.equal(renderCompose({ ...base, ports: [] }), missing);
  assert.ok(!/\bports:/.test(missing), "no ports: key when empty");
});

test("a published port is rendered as a quoted compose mapping", () => {
  const yaml = renderCompose({
    ...base,
    ports: ["16379:6379", "25565:25565/udp"],
  });
  assert.match(
    yaml,
    /\n {4}ports:\n {6}- "16379:6379"\n {6}- "25565:25565\/udp"\n/,
  );
});

test("portMappings writes the protocol only when it is not tcp", () => {
  assert.deepEqual(
    portMappings([
      { id: "prt_1", published: 16379, target: 6379, protocol: "tcp" },
      { id: "prt_2", published: 25565, target: 25565, protocol: "udp" },
    ]),
    ["16379:6379", "25565:25565/udp"],
  );
  assert.deepEqual(portMappings(null), []);
});

// A reroute re-renders from the RUNNING stack, so it must read the ports back
// rather than apply an edit nobody has deployed.
test("parseStackPorts reads the ports the running stack publishes", () => {
  const yaml = renderCompose({ ...base, ports: ["16379:6379"] });
  assert.deepEqual(parseStackPorts(yaml, "deplo-demo"), ["16379:6379"]);
  assert.deepEqual(parseStackPorts(renderCompose(base), "deplo-demo"), []);
  assert.deepEqual(parseStackPorts("not: [yaml", "deplo-demo"), []);
});
