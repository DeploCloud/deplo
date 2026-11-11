import { describe, test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../yaml";
import { renderCompose, renderOverlapStacks } from "./build/compose-render";
import { generateDatabaseCompose } from "./database-compose";
import {
  isForwardedApp,
  originName,
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
      // another Environment on the same members, and a third member of its own
      db("other", ["m1"], ENV_B),
      app("blog", ["m3"], ENV_B),
    ],
  });

  test("every member of an Environment holds exactly that Environment's names", () => {
    assert.deepEqual(
      plan
        .get("m1")!
        .hold.filter((h) => h.network === ENV_A)
        .map((h) => h.name),
      ["db-shop", "deplo-web"],
    );
    assert.deepEqual(
      plan.get("m2")!.hold.map((h) => h.name),
      ["db-shop", "deplo-web"],
    );
    assert.deepEqual(
      plan.get("m3")!.hold.map((h) => [h.network, h.name]),
      [
        [ENV_B, "db-other"],
        [ENV_B, "deplo-blog"],
      ],
    );
  });

  test("the workload's own container answers under its internal alias", () => {
    const held = plan.get("m2")!.hold.find((h) => h.name === "db-shop")!;
    assert.equal(held.origin, "db-shop.origin");
    assert.equal(held.origin, originName("db-shop"));
    assert.equal(held.port, 5432);
  });

  test("a member serves only the workloads placed on it, to its Environment's other members", () => {
    assert.deepEqual(plan.get("m2")!.serve, [
      {
        network: ENV_A,
        kind: "app",
        workloadId: "web",
        port: 3000,
        origin: "deplo-web.origin",
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

  test("another Environment's member is never a source, even on a shared member", () => {
    const toShop = plan.get("m1")!.serve.find((s) => s.workloadId === "shop")!;
    assert.ok(!toShop.sourceFingerprints.includes(FP.m3));
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
      ["db-shop", "deplo-idle", "deplo-web"],
    );
  });

  test("replicas on several members are served by each", () => {
    const p = planNameForwarding({
      fingerprints,
      workloads: [app("web", ["m1", "m2"])],
    });
    assert.deepEqual([...p.keys()].sort(), ["m1", "m2"]);
    assert.equal(p.get("m1")!.serve[0]!.sourceFingerprints[0], FP.m2);
  });
});

describe("what a forwarded workload renders", () => {
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

  test("an App answers under its internal alias, and not under its public name", () => {
    const s = services(renderCompose({ ...base, forwarded: true }));
    assert.deepEqual(Object.keys(s), ["deplo-demo.origin"]);
    assert.equal(s["deplo-demo.origin"]!.container_name, "deplo-demo.origin");
  });

  test("an App off a cluster renders as before", () => {
    const s = services(renderCompose(base));
    assert.deepEqual(Object.keys(s), ["deplo-demo"]);
  });

  test("the overlap stand-in takes the alias, never the public name", () => {
    const { live, standIn } = renderOverlapStacks({ ...base, forwarded: true });
    assert.deepEqual(Object.keys(services(live)), ["deplo-demo.origin"]);
    const next = services(standIn)["deplo-demo_next"]!;
    assert.deepEqual(
      (next.networks as Record<string, { aliases: string[] }>).deplo.aliases,
      ["deplo-demo.origin"],
    );
  });

  test("a database answers under its internal alias", () => {
    const y = generateDatabaseCompose({
      name: "db-shop",
      databaseId: "db1",
      type: "postgres",
      version: "16",
      username: "app",
      password: "pw",
      dbName: "shop",
      network: ENV_A,
      forwarded: true,
    });
    const s = services(y);
    assert.deepEqual(Object.keys(s), ["db-shop.origin"]);
    assert.equal(s["db-shop.origin"]!.container_name, "db-shop.origin");
  });

  test("only a single-image App on a cluster is forwarded", () => {
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
