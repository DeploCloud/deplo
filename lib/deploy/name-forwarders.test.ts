import { describe, test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../yaml";
import { renderCompose } from "./build/compose-render";
import { generateDatabaseCompose } from "./database-compose";
import {
  isForwardedApp,
  planNameForwarding,
  type ForwardedWorkload,
} from "./name-forwarders";

const FP = { m1: "1".repeat(64), m2: "2".repeat(64), m3: "3".repeat(64) };
const fingerprints = new Map(Object.entries(FP));
const ENV_A = "deplo-env-a";
const ENV_B = "deplo-env-b";

const db = (id: string, members: string[], network = ENV_A) =>
  ({
    kind: "database",
    id,
    network,
    name: `db-${id}`,
    port: 5432,
    members,
  }) satisfies ForwardedWorkload;
const app = (id: string, members: string[], network = ENV_A) =>
  ({
    kind: "app",
    id,
    network,
    name: `deplo-${id}`,
    port: 3000,
    members,
  }) satisfies ForwardedWorkload;

describe("which names go on which member", () => {
  const plan = planNameForwarding({
    fingerprints,
    workloads: [
      db("shop", ["m1"]),
      app("web", ["m2"]),
      // another team's Environment on the same member, and a third member of its own
      db("other", ["m1"], ENV_B),
      app("blog", ["m3"], ENV_B),
    ],
  });
  const held = (member: string) =>
    plan.get(member)!.hold.map((h) => [h.network, h.name, h.port]);

  test("a member holds exactly its Environment's names that run on another member", () => {
    assert.deepEqual(held("m1"), [
      [ENV_A, "deplo-web", 3000],
      [ENV_B, "deplo-blog", 3000],
    ]);
    assert.deepEqual(held("m2"), [[ENV_A, "db-shop", 5432]]);
    assert.deepEqual(held("m3"), [[ENV_B, "db-other", 5432]]);
  });

  test("a workload's own member holds no forwarder for it: its container keeps the name", () => {
    for (const [member, own] of [
      ["m1", "db-shop"],
      ["m1", "db-other"],
      ["m2", "deplo-web"],
      ["m3", "deplo-blog"],
    ] as const)
      assert.ok(!plan.get(member)!.hold.some((h) => h.name === own));
  });

  test("a member serves only the workloads placed on it, to its Environment's other members", () => {
    assert.deepEqual(plan.get("m2")!.serve, [
      {
        network: ENV_A,
        kind: "app",
        workloadId: "web",
        port: 3000,
        sourceFingerprints: [FP.m1],
      },
    ]);
    const m1 = plan.get("m1")!.serve;
    assert.deepEqual(
      m1.map((s) => [s.network, s.workloadId, s.sourceFingerprints]),
      [
        [ENV_A, "shop", [FP.m2]],
        [ENV_B, "other", [FP.m3]],
      ],
    );
  });

  test("another team's member is never a source and never holds the name, even on a shared member", () => {
    const toShop = plan.get("m1")!.serve.find((s) => s.workloadId === "shop")!;
    assert.ok(!toShop.sourceFingerprints.includes(FP.m3));
    assert.ok(!plan.get("m3")!.hold.some((h) => h.network === ENV_A));
    assert.ok(!plan.get("m2")!.hold.some((h) => h.network === ENV_B));
    assert.deepEqual(
      plan.get("m3")!.serve.map((s) => s.workloadId),
      ["blog"],
    );
  });

  test("a workload waiting for room, or a member with no certificate, adds nothing", () => {
    const p = planNameForwarding({
      fingerprints: new Map([["m1", FP.m1]]),
      workloads: [db("shop", ["m1"]), app("web", ["m2"]), app("idle", [])],
    });
    assert.deepEqual(p.get("m1")!.serve[0]!.sourceFingerprints, []);
    assert.deepEqual(
      p.get("m1")!.hold.map((h) => h.name),
      ["deplo-idle", "deplo-web"],
    );
  });

  test("replicas on several members are served by each and held by the rest", () => {
    const p = planNameForwarding({
      fingerprints,
      workloads: [app("web", ["m1", "m2"]), db("shop", ["m3"])],
    });
    assert.equal(
      p.get("m1")!.serve[0]!.sourceFingerprints.join(),
      [FP.m2, FP.m3].join(),
    );
    assert.deepEqual(
      p.get("m3")!.hold.map((h) => h.name),
      ["deplo-web"],
    );
    assert.ok(!p.get("m1")!.hold.some((h) => h.name === "deplo-web"));
  });

  test("a compose stack reaches its Environment's names from its member and offers none", () => {
    const stack = { ...app("stack", ["m2"]), name: null };
    const p = planNameForwarding({
      fingerprints,
      workloads: [db("shop", ["m1"]), stack],
    });
    assert.deepEqual(
      p.get("m2")!.hold.map((h) => h.name),
      ["db-shop"],
    );
    assert.deepEqual(p.get("m2")!.serve, []);
    assert.deepEqual(p.get("m1")!.hold, []);
    assert.deepEqual(p.get("m1")!.serve[0]!.sourceFingerprints, [FP.m2]);
  });

  test("a name the proxy resolves on every network is never held or served", () => {
    for (const name of [
      "deplo",
      "postgres",
      "traefik",
      "deplo-traefik",
      "docker-socket-proxy",
      "deplo-socket-proxy",
    ]) {
      const p = planNameForwarding({
        fingerprints,
        workloads: [{ ...db("x", ["m1"]), name }, app("web", ["m2"])],
      });
      assert.deepEqual(p.get("m2")!.hold, [], name);
      assert.deepEqual(
        p.get("m1")!.serve.map((s) => s.workloadId),
        [],
        name,
      );
    }
  });
});

describe("what a workload on a cluster renders", () => {
  const base = {
    network: ENV_A,
    name: "deplo-demo",
    image: "deplo/demo:abc123",
    port: 3000,
    appId: "p1",
    deployKey: "demo",
    routes: [],
    env: {},
  };
  const services = (y: string) =>
    (yaml.load(y) as { services: Record<string, Record<string, unknown>> })
      .services;

  test("an App keeps its own name, so the server agent still finds its container", () => {
    const s = services(renderCompose(base));
    assert.deepEqual(Object.keys(s), ["deplo-demo"]);
    assert.equal(s["deplo-demo"]!.container_name, "deplo-demo");
    assert.ok(
      (s["deplo-demo"]!.labels as string[]).includes("deplo.project=p1"),
    );
  });

  test("a database keeps its own name and carries the id a forwarder finds it by", () => {
    const y = generateDatabaseCompose({
      name: "db-shop",
      databaseId: "db1",
      type: "postgres",
      version: "16",
      username: "app",
      password: "pw",
      dbName: "shop",
      network: ENV_A,
    });
    const s = services(y);
    assert.deepEqual(Object.keys(s), ["db-shop"]);
    assert.ok((s["db-shop"]!.labels as string[]).includes("deplo.project=db1"));
  });

  test("only a single-image App on a cluster has its name forwarded", () => {
    const image = {
      source: "docker-image",
      compose: null,
      repo: null,
      dockerImage: "nginx",
    };
    assert.equal(isForwardedApp({ ...image, clusterId: "cl1" }), true);
    assert.equal(isForwardedApp({ ...image, clusterId: null }), false);
    assert.equal(isForwardedApp({ ...image, clusterId: "cl1" }, true), false);
    assert.equal(
      isForwardedApp({
        source: "compose",
        compose: "services: {}",
        repo: null,
        dockerImage: null,
        clusterId: "cl1",
      }),
      false,
    );
  });
});
