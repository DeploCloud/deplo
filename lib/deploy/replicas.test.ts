import { describe, test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../yaml";
import { renderCompose, renderOverlapStacks } from "./build/compose-render";
import { assertComposeSavable } from "../data/apps/source-guards";
import { buildComposeStack } from "./compose-stack/render";
import { lintCompose } from "./compose-lint/lint";
import {
  REPLICAS_DATA_MESSAGE,
  cleanReplicas,
  composeReplicasConflicts,
  replicasRefusal,
} from "./replicas";

const vol = (type: "named" | "app" | "host") => ({
  id: "v",
  type,
  name: "data",
  mountPath: "/data",
  readOnly: false,
});
const port = { id: "p", published: 25565, target: 25565, protocol: "tcp" };
const guard = (
  app: { volumes: ReturnType<typeof vol>[]; ports: (typeof port)[] },
  n: number,
) => replicasRefusal(app as never, n);

describe("the replicas guard", () => {
  test("one copy is always allowed", () => {
    assert.equal(guard({ volumes: [vol("named")], ports: [port] }, 1), null);
  });

  test("a Volume, a Bind or a published port refuses more than one copy", () => {
    for (const app of [
      { volumes: [vol("named")], ports: [] },
      { volumes: [vol("host")], ports: [] },
      { volumes: [], ports: [port] },
    ])
      assert.equal(
        guard(app, 2),
        "An App that keeps data on its own disk runs one copy. Keep the data in a database to run more.",
      );
  });

  test("Files and a bare app pass", () => {
    assert.equal(guard({ volumes: [vol("app")], ports: [] }, 5), null);
    assert.equal(guard({ volumes: [], ports: [] }, 10), null);
  });

  test("the count is a whole number from 1 to 10", () => {
    for (const n of [0, 11, 1.5, -1, NaN])
      assert.throws(() => cleanReplicas(n), /1 to 10/);
    assert.equal(cleanReplicas(10), 10);
  });
});

describe("compose stacks", () => {
  const stack = (svc: string) =>
    `services:\n  web:\n    image: nginx:1\n    deploy:\n      replicas: 3\n${svc}`;

  test("refuse replicas > 1 on a named volume, a host path or a published port", () => {
    for (const extra of [
      "    volumes:\n      - data:/data\n",
      "    volumes:\n      - /srv/x:/data\n",
      "    volumes:\n      - type: volume\n        source: data\n        target: /data\n",
      '    ports:\n      - "8080:80"\n',
    ])
      assert.deepEqual(composeReplicasConflicts(stack(extra)), ["web"], extra);
  });

  test("allow Files, an anonymous volume, and one copy", () => {
    assert.deepEqual(
      composeReplicasConflicts(
        stack("    volumes:\n      - ./conf:/etc/conf\n      - /cache\n"),
      ),
      [],
    );
    assert.deepEqual(
      composeReplicasConflicts(
        "services:\n  web:\n    image: x\n    volumes:\n      - data:/data\n",
      ),
      [],
    );
  });

  test("the editor reports it as an error with the same message", () => {
    const diag = lintCompose(stack("    volumes:\n      - data:/data\n")).find(
      (d) => d.rule === "replicas-storage",
    );
    assert.equal(diag?.severity, "error");
    assert.equal(diag?.message, REPLICAS_DATA_MESSAGE);
  });
});

describe("a compose stack with replicas", () => {
  const stackYaml = (extra: string, replicas = 3) =>
    `services:\n  web:\n    image: x\n    deploy:\n      replicas: ${replicas}\n${extra}`;
  const build = (compose: string) =>
    buildComposeStack({
      network: "deplo-team-team_test",
      compose,
      name: "deplo-demo",
      deployKey: "demo",
      appId: "p1",
      domainRoutes: [],
    });

  test("renders three copies when it keeps no disk and publishes no port", () => {
    const doc = yaml.load(build(stackYaml(""))) as {
      services: Record<string, { deploy?: { replicas?: number } }>;
    };
    assert.equal(doc.services.web.deploy?.replicas, 3);
  });

  for (const extra of [
    "    volumes:\n      - data:/data\n",
    "    volumes:\n      - /srv/x:/data\n",
    '    ports:\n      - "8080:80"\n',
  ])
    test(`the render refuses ${extra.trim().split("\n").pop()?.trim()}`, () => {
      assert.throws(() => build(stackYaml(extra)), {
        message: REPLICAS_DATA_MESSAGE,
      });
    });

  test("one copy with a volume still renders", () => {
    assert.doesNotThrow(() =>
      build(stackYaml("    volumes:\n      - data:/data\n", 1)),
    );
  });

  test("saving refuses it with the same message", async () => {
    for (const extra of [
      "    volumes:\n      - data:/data\n",
      '    ports:\n      - "8080:80"\n',
    ])
      await assert.rejects(assertComposeSavable(stackYaml(extra)), {
        message: REPLICAS_DATA_MESSAGE,
      });
    await assert.doesNotReject(assertComposeSavable(stackYaml("")));
  });
});

describe("rendering replicas", () => {
  const base = {
    network: "deplo-env-environ_1",
    name: "deplo-demo",
    image: "deplo/demo:abc123",
    port: 3000,
    appId: "p1",
    deployKey: "demo",
    routes: [],
    env: {},
  };
  type Svc = { container_name?: string; deploy?: { replicas?: number } };
  const service = (y: string) =>
    Object.values(
      (yaml.load(y) as { services: Record<string, Svc> }).services,
    )[0];

  test("several copies have no fixed container name and ask for that many", () => {
    const svc = service(renderCompose({ ...base, replicas: 3 }));
    assert.equal(svc.container_name, undefined);
    assert.equal(svc.deploy?.replicas, 3);
  });

  test("one copy renders as it always did", () => {
    assert.equal(renderCompose({ ...base, replicas: 1 }), renderCompose(base));
    const svc = service(renderCompose(base));
    assert.equal(svc.container_name, "deplo-demo");
    assert.equal(svc.deploy, undefined);
  });

  test("the live stack and the stand-in both ask for every copy", () => {
    const { live, standIn } = renderOverlapStacks({ ...base, replicas: 3 });
    for (const y of [live, standIn]) {
      const svc = service(y);
      assert.equal(svc.container_name, undefined);
      assert.equal(svc.deploy?.replicas, 3);
    }
  });
});
