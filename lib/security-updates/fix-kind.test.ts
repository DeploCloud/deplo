import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fixKind,
  isActionable,
  levelOf,
  qualifiesForAlert,
  type FixInput,
} from "./fix-kind";

const base: FixInput = {
  imageRef: "deplo/web:dpl_123",
  builder: "dockerfile",
  ecosystem: "npm",
  location: "/app/node_modules/minimist/package.json",
  workingDir: "/app",
  fixedVersion: "1.2.6",
  repoDigest: "",
  registryStatus: null,
  registryDigest: null,
  newerTag: null,
};

test("fixKind: Deplo-built images", () => {
  assert.equal(fixKind(base), "code");
  assert.equal(
    fixKind({ ...base, location: "/usr/local/lib/node_modules/npm/x" }),
    "rebuild",
  );
  assert.equal(fixKind({ ...base, ecosystem: "Debian:12" }), "rebuild");
  assert.equal(
    fixKind({ ...base, builder: "railpack", ecosystem: "Debian:13" }),
    "deplo",
  );
  assert.equal(fixKind({ ...base, builder: "railpack" }), "code");
  assert.equal(fixKind({ ...base, workingDir: "/" }), "rebuild");
});

test("fixKind: a vendor image is fixed only by what its registry has", () => {
  const vendor: FixInput = {
    ...base,
    imageRef: "postgres:16-alpine",
    ecosystem: "Go",
    repoDigest: "sha256:old",
  };
  assert.equal(fixKind(vendor), "none");
  assert.equal(
    fixKind({ ...vendor, registryStatus: "ok", registryDigest: "sha256:new" }),
    "update",
  );
  assert.equal(
    fixKind({ ...vendor, registryStatus: "ok", registryDigest: "sha256:old" }),
    "none",
  );
  assert.equal(
    fixKind({
      ...vendor,
      registryStatus: "ok",
      registryDigest: "sha256:old",
      newerTag: "16.5-alpine",
    }),
    "newer_tag",
  );
  assert.equal(fixKind({ ...vendor, registryStatus: "private" }), "update");
});

test("fixKind: without an upstream fix nothing helps", () => {
  assert.equal(fixKind({ ...base, fixedVersion: null }), "none");
});

test("levelOf: known-exploited beats any score; medium and below are dropped", () => {
  const kev = new Set(["CVE-2021-44228"]);
  assert.equal(levelOf("medium", "CVE-2021-44228", kev), "exploited");
  assert.equal(levelOf(null, "CVE-2021-44228", kev), "exploited");
  assert.equal(levelOf("critical", "CVE-1", kev), "critical");
  assert.equal(levelOf("high", null, kev), "high");
  assert.equal(levelOf("medium", "CVE-1", kev), null);
  assert.equal(levelOf(null, null, kev), null);
});

test("isActionable / qualifiesForAlert", () => {
  assert.equal(isActionable("deplo", "critical"), false);
  assert.equal(isActionable("none", "exploited"), true);
  assert.equal(isActionable("newer_tag", "high"), true);
  assert.equal(qualifiesForAlert("code", "critical"), true);
  assert.equal(qualifiesForAlert("code", "high"), false);
  assert.equal(qualifiesForAlert("none", "critical"), false);
  assert.equal(qualifiesForAlert("none", "exploited"), true);
});
