import { test } from "node:test";
import assert from "node:assert/strict";

import { compareVersions, countUpdates, groupByPackage } from "./group";

const f = (o: Partial<Parameters<typeof groupByPackage>[0][number]>) => ({
  service: "web",
  ecosystem: "npm",
  packageName: "n8n",
  installedVersion: "1.45.0",
  level: "critical",
  fix: "update",
  fixedVersion: "1.123.55",
  ...o,
});

test("many advisories on one package are one security update", () => {
  const items = [
    f({}),
    f({ fixedVersion: "2.26.2" }),
    f({ level: "exploited", fixedVersion: "1.120.4" }),
    f({
      packageName: "openssl",
      ecosystem: "Alpine:v3.19",
      level: "high",
      fixedVersion: "3.1.6-r0",
    }),
    f({ packageName: "zlib", fix: "none", fixedVersion: null, level: "high" }),
  ];
  const groups = groupByPackage(items);
  assert.equal(groups.length, 3);
  const n8n = groups.find((g) => g.items[0].packageName === "n8n")!;
  assert.equal(n8n.items.length, 3);
  assert.equal(n8n.level, "exploited");
  assert.equal(n8n.fixedVersion, "2.26.2", "the version that closes them all");
  assert.deepEqual(countUpdates(items), { count: 2, exploited: 1 });
});

test("compareVersions orders numbers numerically", () => {
  assert.ok(compareVersions("1.123.55", "1.45.0") > 0);
  assert.ok(compareVersions("3.0.15-1~deb12u1", "3.0.9-1~deb12u1") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});
