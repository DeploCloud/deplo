import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareVersions,
  countUpdates,
  groupUpdates,
  packagesOf,
} from "./group";

const f = (o: Partial<Parameters<typeof groupUpdates>[0][number]>) => ({
  service: "web",
  ecosystem: "npm",
  packageName: "minimist",
  installedVersion: "1.2.5",
  level: "critical",
  fix: "code",
  fixedVersion: "1.2.6",
  actionable: true,
  ...o,
});

test("many advisories on one package are one security update", () => {
  const items = [
    f({}),
    f({ fixedVersion: "1.2.8" }),
    f({ level: "exploited", fixedVersion: "1.2.7" }),
    f({ packageName: "lodash", level: "high", actionable: false }),
  ];
  const groups = groupUpdates(items);
  assert.equal(groups.length, 2);
  const minimist = groups.find((g) => g.items[0].packageName === "minimist")!;
  assert.equal(minimist.items.length, 3);
  assert.equal(minimist.level, "exploited");
  assert.equal(
    minimist.fixedVersion,
    "1.2.8",
    "the version that closes them all",
  );
  assert.deepEqual(countUpdates(items), { count: 1, exploited: 1 });
});

test("an image's update is one update, however many packages it moves", () => {
  const image = { fix: "update", fixedVersion: null };
  const items = [
    f({ ...image, packageName: "next", installedVersion: "16.3.5" }),
    f({ ...image, packageName: "axios", installedVersion: "1.6.0" }),
    f({ ...image, service: "worker", packageName: "next" }),
  ];
  const groups = groupUpdates(items);
  assert.equal(groups.length, 2, "one per service image");
  assert.ok(groups.every((g) => g.image && g.fixedVersion === null));
  assert.deepEqual(countUpdates(items), { count: 2, exploited: 0 });
});

test("packagesOf lists an image's packages once each, in order, with their advisories", () => {
  const items = [
    f({ packageName: "next", installedVersion: "16.3.5" }),
    f({ packageName: "axios", installedVersion: "1.6.0" }),
    f({ packageName: "next", installedVersion: "16.3.5" }),
  ];
  assert.deepEqual(
    packagesOf(items).map((p) => `${p.packageName}:${p.items.length}`),
    ["next:2", "axios:1"],
  );
});

test("compareVersions orders numbers numerically", () => {
  assert.ok(compareVersions("1.123.55", "1.45.0") > 0);
  assert.ok(compareVersions("3.0.15-1~deb12u1", "3.0.9-1~deb12u1") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});
