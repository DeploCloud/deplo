import { describe, test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../yaml";
import { renderCompose, renderOverlapStacks } from "./build/compose-render";
import { agentProbeMount, portProbeCommand } from "./port-probe";
import {
  parseStackHealthCheck,
  readStackVolumesFromYaml,
  stackRunsAgentProbe,
} from "./build/stack-yaml";
import type { RoutableDomain } from "../data/domains/routes";

const route: RoutableDomain = {
  name: "demo.example.com",
  port: null,
  entrypoint: "websecure",
  tls: true,
  certResolver: "letsencrypt",
  middlewares: [],
  securityHeaders: false,
  corsOrigins: [],
  pathPrefix: "",
  stripPrefix: false,
  service: null,
  redirectTo: "",
};

const base = {
  network: "deplo-env-environ_1",
  name: "deplo-demo",
  image: "deplo/demo:abc123",
  port: 3000,
  appId: "p1",
  deployKey: "demo",
  routes: [route],
  env: { FOO: "bar" },
  volumes: [{ name: "data", mountPath: "/data" }],
  basicAuthUsers: "admin:$2y$05$hash",
};

type Svc = {
  image: string;
  container_name: string;
  environment: Record<string, string>;
  volumes: string[];
  labels: string[];
  ports?: unknown;
  networks: Record<string, { aliases?: string[] } | null> | string[];
  healthcheck?: Record<string, unknown>;
};

function only(stack: string): [string, Svc] {
  const doc = yaml.load(stack) as { services: Record<string, Svc> };
  const entries = Object.entries(doc.services);
  assert.equal(entries.length, 1);
  return entries[0];
}

const routing = (labels: string[]) =>
  labels.filter((l) => l.startsWith("traefik.")).sort();

// Compose reads `$$` as one `$`, so this is what the container's shell receives.
const uninterpolated = (s: string) => s.replace(/\$\$/g, "$");

describe("stand-in stack", () => {
  const { live, standIn } = renderOverlapStacks(base);
  const [liveName, liveSvc] = only(live);
  const [standInName, standInSvc] = only(standIn);

  test("runs beside the live container under a name no app can take", () => {
    assert.equal(liveName, "deplo-demo");
    assert.equal(liveSvc.container_name, "deplo-demo");
    assert.equal(standInName, "deplo-demo_next");
    assert.equal(standInSvc.container_name, "deplo-demo_next");
  });

  // Identical routers and services: the proxy load-balances both instead of dropping a conflict.
  test("carries exactly the live container's routes", () => {
    assert.ok(routing(liveSvc.labels).length > 0);
    assert.deepEqual(routing(standInSvc.labels), routing(liveSvc.labels));
  });

  test("answers to the live container's name for apps that link to it", () => {
    const nets = standInSvc.networks as Record<string, { aliases?: string[] }>;
    assert.deepEqual(nets.deplo.aliases, ["deplo-demo"]);
  });

  test("runs the same release: image, variables and storage", () => {
    assert.equal(standInSvc.image, liveSvc.image);
    assert.deepEqual(standInSvc.environment, liveSvc.environment);
    assert.deepEqual(standInSvc.volumes, liveSvc.volumes);
  });

  test("is marked as a stand-in, still under the app's own slug", () => {
    assert.ok(standInSvc.labels.includes("deplo.stand-in=true"));
    assert.ok(standInSvc.labels.includes("deplo.slug=demo"));
    assert.ok(!liveSvc.labels.includes("deplo.stand-in=true"));
  });

  // The proxy routes to a container with a health check only once it is healthy.
  test("both get the port probe when the app has no health check", () => {
    for (const svc of [liveSvc, standInSvc]) {
      const [kind, command] = svc.healthcheck!.test as string[];
      assert.equal(kind, "CMD-SHELL");
      assert.equal(uninterpolated(command), portProbeCommand(3000));
      assert.doesNotMatch(command, /(^|[^$])\$([^$]|$)/, "every $ escaped");
      assert.equal(svc.healthcheck!.start_interval, "1s");
    }
  });

  test("an app's own health check is kept, probed every second while it starts", () => {
    const own = renderOverlapStacks({
      ...base,
      healthCheck: {
        type: "command",
        path: null,
        port: null,
        command: "curl -f http://localhost:3000/health",
        intervalS: 30,
        timeoutS: 5,
        retries: 3,
        startPeriodS: 10,
      },
    });
    for (const stack of [own.live, own.standIn]) {
      const hc = only(stack)[1].healthcheck!;
      assert.deepEqual(hc.test, [
        "CMD-SHELL",
        "curl -f http://localhost:3000/health",
      ]);
      assert.equal(hc.start_interval, "1s");
    }
  });

  // deplo#281: an image with no shell (scratch, distroless) passes the agent's own probe, mounted read-only.
  test("with the agent's probe, both run it from its mount and no shell is needed", () => {
    const probed = renderOverlapStacks({ ...base, agentProbe: true });
    for (const stack of [probed.live, probed.standIn]) {
      const svc = only(stack)[1];
      assert.deepEqual(svc.healthcheck!.test, [
        "CMD",
        "/.deplo-probe/deplo-agent",
        "probe",
        "3000",
      ]);
      assert.equal(svc.healthcheck!.start_interval, "1s");
      assert.deepEqual(svc.volumes, ["data:/data", agentProbeMount()]);
      assert.doesNotMatch(stack, /CMD-SHELL|\/proc\/net/);
    }
  });

  // A reroute re-renders what it reads back: one mount, the stack unchanged byte for byte.
  test("a probed stack read back renders the same again", () => {
    const { live } = renderOverlapStacks({ ...base, agentProbe: true });
    const again = renderCompose({
      ...base,
      volumes: readStackVolumesFromYaml(live, "deplo-demo"),
      healthCheckKeys: parseStackHealthCheck(live, "deplo-demo"),
    });
    assert.equal(again, live);
    assert.equal(stackRunsAgentProbe(live), true, "a stack's reroute keeps it");
    assert.equal(stackRunsAgentProbe(renderOverlapStacks(base).live), false);
  });

  test("an in-place deploy renders the stack it always did", () => {
    assert.equal(renderCompose(base), renderCompose({ ...base }));
    assert.ok(!/healthcheck:/.test(renderCompose(base)));
  });
});
