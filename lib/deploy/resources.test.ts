import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

import {
  resourceLimitsToComposeKeys,
  renderResourceLimitsYaml,
  mergeResourceLimits,
} from "./resources";
import { renderCompose } from "./build";
import { buildComposeStack } from "./compose-stack";
import type { ResourceLimits } from "../types";
import type { RoutableDomain } from "../data/domains";

/**
 * Per-app resource limits → `docker compose up` keys. The load-bearing
 * contracts: (1) no limits ⇒ NO keys emitted (byte-identical stack, the reroute
 * contract); (2) the unit mapping (MiB→`<n>m`, GiB→`<n>G`, milli-CPU→fractional
 * cores); (3) compose-stack apply is per-service and existing-wins.
 */

/** A ResourceLimits with everything unset, overlaid with `p`. */
function mk(p: Partial<ResourceLimits>): ResourceLimits {
  return {
    memoryMb: null,
    memoryReservationMb: null,
    swapMb: null,
    cpuMilli: null,
    cpuShares: null,
    cpuset: null,
    pidsLimit: null,
    shmSizeMb: null,
    storageGb: null,
    nofile: null,
    nproc: null,
    oomScoreAdj: null,
    ...p,
  };
}

/* ---- resourceLimitsToComposeKeys ------------------------------------ */

test("no limits ⇒ empty key set (null and all-null both)", () => {
  assert.deepEqual(resourceLimitsToComposeKeys(null), {});
  assert.deepEqual(resourceLimitsToComposeKeys(undefined), {});
  assert.deepEqual(resourceLimitsToComposeKeys(mk({})), {});
});

test("units + cpu conversion map to the compose-up keys", () => {
  const keys = resourceLimitsToComposeKeys(
    mk({
      memoryMb: 512,
      memoryReservationMb: 256,
      swapMb: 1024,
      cpuMilli: 500,
      cpuShares: 2048,
      cpuset: "0-3",
      pidsLimit: 100,
      shmSizeMb: 64,
      storageGb: 10,
      nofile: 1024,
      nproc: 512,
      oomScoreAdj: -500,
    }),
  );
  assert.deepEqual(keys, {
    mem_limit: "512m",
    mem_reservation: "256m",
    memswap_limit: "1024m",
    cpus: "0.5",
    cpu_shares: 2048,
    cpuset: "0-3",
    pids_limit: 100,
    shm_size: "64m",
    storage_opt: { size: "10G" },
    ulimits: { nofile: 1024, nproc: 512 },
    oom_score_adj: -500,
  });
});

test("cpu milli renders as a fractional-core string", () => {
  assert.equal(resourceLimitsToComposeKeys(mk({ cpuMilli: 2000 })).cpus, "2");
  assert.equal(resourceLimitsToComposeKeys(mk({ cpuMilli: 250 })).cpus, "0.25");
  assert.equal(resourceLimitsToComposeKeys(mk({ cpuMilli: 1500 })).cpus, "1.5");
});

test("ulimits is emitted only for the sub-limits that are set", () => {
  assert.deepEqual(resourceLimitsToComposeKeys(mk({ nofile: 1024 })).ulimits, {
    nofile: 1024,
  });
  assert.equal(resourceLimitsToComposeKeys(mk({ cpuMilli: 1000 })).ulimits, undefined);
});

/* ---- renderResourceLimitsYaml --------------------------------------- */

test("YAML fragment is empty when there are no limits", () => {
  assert.equal(renderResourceLimitsYaml(null, 4), "");
  assert.equal(renderResourceLimitsYaml(mk({}), 4), "");
});

test("YAML fragment indents nested maps correctly and re-parses", () => {
  const frag = renderResourceLimitsYaml(
    mk({ memoryMb: 512, nofile: 1024, storageGb: 10 }),
    4,
  );
  // Service-level keys at 4 spaces, nested map keys at 6.
  assert.match(frag, /^ {4}mem_limit: 512m$/m);
  assert.match(frag, /^ {4}ulimits:$/m);
  assert.match(frag, /^ {6}nofile: 1024$/m);
  // The fragment is valid YAML on its own (indentation is internally consistent).
  const parsed = yaml.load(frag.replace(/^ {4}/gm, "")) as Record<string, unknown>;
  assert.equal(parsed.mem_limit, "512m");
  assert.deepEqual(parsed.storage_opt, { size: "10G" });
});

/* ---- renderCompose (single-image) integration ----------------------- */

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
};
const base = {
  name: "deplo-demo",
  image: "deplo/demo:abc",
  port: 3000,
  appId: "p1",
  slug: "demo",
  routes: [route],
  env: { FOO: "bar" },
};

test("renderCompose is byte-identical when there are no limits", () => {
  const withMissing = renderCompose(base);
  const withNull = renderCompose({ ...base, resources: null });
  const withEmpty = renderCompose({ ...base, resources: mk({}) });
  assert.equal(withNull, withMissing);
  assert.equal(withEmpty, withMissing);
  assert.ok(!/mem_limit|cpus:|pids_limit/.test(withMissing));
});

test("renderCompose emits the limit keys and the stack still parses", () => {
  const yamlStr = renderCompose({
    ...base,
    resources: mk({ memoryMb: 512, cpuMilli: 500, pidsLimit: 100, nofile: 1024, storageGb: 10 }),
  });
  const doc = yaml.load(yamlStr) as {
    services: Record<string, Record<string, unknown>>;
  };
  const svc = doc.services["deplo-demo"];
  assert.equal(svc.mem_limit, "512m");
  assert.equal(svc.cpus, "0.5");
  assert.equal(svc.pids_limit, 100);
  assert.deepEqual(svc.ulimits, { nofile: 1024 });
  assert.deepEqual(svc.storage_opt, { size: "10G" });
  // The image/labels/network keys are still present alongside the new ones.
  assert.equal(svc.image, "deplo/demo:abc");
  assert.ok(Array.isArray(svc.labels));
});

/* ---- mergeResourceLimits (compose-stack overlay) -------------------- */

test("mergeResourceLimits is existing-wins and a no-op for null", () => {
  const svc: Record<string, unknown> = { image: "x", mem_limit: "1g" };
  mergeResourceLimits(svc, mk({ memoryMb: 512, cpuMilli: 1000 }));
  // The service's own mem_limit is kept; the missing cpus is added.
  assert.equal(svc.mem_limit, "1g");
  assert.equal(svc.cpus, "1");

  const untouched: Record<string, unknown> = { image: "x" };
  mergeResourceLimits(untouched, null);
  assert.deepEqual(untouched, { image: "x" });
});

/* ---- buildComposeStack integration ---------------------------------- */

test("buildComposeStack applies caps to every service, existing-wins", () => {
  const compose = [
    "services:",
    "  web:",
    "    image: nginx",
    "  worker:",
    "    image: worker",
    "    mem_limit: 2g",
  ].join("\n");
  const out = buildComposeStack({
    compose,
    name: "deplo-demo",
    slug: "demo",
    appId: "p1",
    domainRoutes: [],
    resources: mk({ memoryMb: 512, cpuMilli: 1000 }),
  });
  const doc = yaml.load(out) as {
    services: Record<string, Record<string, unknown>>;
  };
  // `web` had no limit ⇒ gets the app-level cap; `worker` keeps its own mem_limit
  // but still gets the (absent) cpus cap.
  assert.equal(doc.services.web.mem_limit, "512m");
  assert.equal(doc.services.web.cpus, "1");
  assert.equal(doc.services.worker.mem_limit, "2g");
  assert.equal(doc.services.worker.cpus, "1");
});

test("buildComposeStack leaves services untouched when there are no limits", () => {
  const compose = "services:\n  web:\n    image: nginx\n";
  const out = buildComposeStack({
    compose,
    name: "deplo-demo",
    slug: "demo",
    appId: "p1",
    domainRoutes: [],
    resources: null,
  });
  assert.ok(!/mem_limit|cpus:/.test(out));
});
