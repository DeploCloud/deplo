import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fixKind,
  inScope,
  isActionable,
  levelOf,
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
  candidate: "unread",
  buildOnly: false,
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
  const composeBuilt = {
    ...base,
    imageRef: "deplo-diun-generator",
    registryStatus: "private",
  };
  assert.equal(
    fixKind({ ...composeBuilt, location: "/usr/bin/yq", ecosystem: "Go" }),
    "rebuild",
    "a compose service Deplo built is the app's, not a private vendor image",
  );
  assert.equal(fixKind(composeBuilt), "code");
});

test("fixKind: a vendor image is fixed only by what its registry has", () => {
  const vendor: FixInput = {
    ...base,
    imageRef: "postgres:16-alpine",
    ecosystem: "Go",
    repoDigest: "sha256:old",
  };
  assert.equal(fixKind(vendor), "none");
  const newerBuild = {
    ...vendor,
    registryStatus: "ok",
    registryDigest: "sha256:new",
  };
  assert.equal(
    fixKind({ ...newerBuild, candidate: "fixed" }),
    "update",
    "Update only once the newer build was read and has the fix",
  );
  assert.equal(
    fixKind({ ...newerBuild, candidate: "vulnerable" }),
    "upstream",
    "a newer build that keeps the flaw waits on the maintainers",
  );
  assert.equal(fixKind(newerBuild), "unverified", "not read yet");
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
      candidate: "fixed",
    }),
    "newer_tag",
  );
  assert.equal(fixKind({ ...vendor, registryStatus: "private" }), "update");
});

test("fixKind: a package only the build uses never counts, wherever it is", () => {
  assert.equal(fixKind({ ...base, buildOnly: true }), "build_only");
  assert.equal(
    fixKind({
      ...base,
      imageRef: "ghcr.io/acme/tool:1",
      registryStatus: "ok",
      registryDigest: "sha256:new",
      repoDigest: "sha256:old",
      candidate: "fixed",
      buildOnly: true,
    }),
    "none",
    "a vendor's dev tools are not listed: the team cannot change them",
  );
  assert.equal(
    isActionable({
      fix: "build_only",
      ecosystem: "npm",
      packageName: "happy-dom",
      location: "/app/node_modules/happy-dom/package.json",
      level: "critical",
    }),
    false,
  );
});

test("fixKind: the app's packages installed outside its folder are still its own", () => {
  const railpack = { ...base, builder: "railpack" };
  assert.equal(
    fixKind({
      ...railpack,
      ecosystem: "RubyGems",
      location: "/usr/local/bundle/specifications/rack-2.2.3.gemspec",
    }),
    "code",
    "Bundler's gems",
  );
  assert.equal(
    fixKind({
      ...railpack,
      ecosystem: "RubyGems",
      location:
        "/mise/installs/ruby/3.1.6/lib/ruby/gems/3.1.0/specifications/default/json-2.6.1.gemspec",
    }),
    "deplo",
    "the runtime's default gems",
  );
  assert.equal(
    fixKind({
      ...base,
      ecosystem: "PyPI",
      location:
        "/usr/local/lib/python3.12/site-packages/pyyaml-5.3.1.dist-info/METADATA",
    }),
    "code",
    "a Dockerfile's pip install",
  );
});

test("fixKind: a managed database's language packages belong to its bundled tools", () => {
  const db: FixInput = {
    ...base,
    imageRef: "mysql:8.4",
    ecosystem: "PyPI",
    location: "/usr/lib/mysqlsh/lib/python3.13/site-packages/x/METADATA",
    registryStatus: "ok",
    repoDigest: "sha256:old",
    registryDigest: "sha256:new",
    candidate: "fixed",
  };
  assert.equal(fixKind(db), "update", "an app on the same image");
  assert.equal(fixKind({ ...db, database: true }), "none");
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

test("inScope: only the app's own dependencies, or what an image ships", () => {
  const f = (o: Partial<Parameters<typeof inScope>[0]>) => ({
    fix: "code",
    ecosystem: "npm",
    packageName: "dompurify",
    location: "/app/node_modules/dompurify/package.json",
    ...o,
  });
  assert.equal(inScope(f({})), true, "a dependency of the app");
  assert.equal(
    inScope(
      f({
        ecosystem: "Go",
        packageName: "stdlib",
        location:
          "/app/node_modules/drizzle-kit/node_modules/@esbuild/linux-x64/bin/esbuild",
      }),
    ),
    false,
    "a Go binary another npm package carries",
  );
  assert.equal(
    inScope(f({ ecosystem: "PyPI", location: "/app/node_modules/x/setup.py" })),
    false,
  );
  assert.equal(inScope(f({ fix: "deplo" })), false, "the runtime is Deplo's");
  assert.equal(
    inScope(
      f({ ecosystem: "Go", packageName: "stdlib", location: "/app/server" }),
    ),
    false,
    "the Go toolchain the app is built with",
  );
  for (const tool of ["pip", "setuptools", "wheel"])
    assert.equal(
      inScope(
        f({
          ecosystem: "PyPI",
          packageName: tool,
          location: `/app/.venv/lib/python3.9/site-packages/${tool}-1.0.dist-info/METADATA`,
        }),
      ),
      false,
      `${tool} is Python's own tooling`,
    );
  assert.equal(
    inScope(
      f({
        ecosystem: "PyPI",
        packageName: "jaraco-context",
        location:
          "/app/.venv/lib/python3.9/site-packages/setuptools/_vendor/jaraco.context-5.3.0.dist-info/METADATA",
      }),
    ),
    false,
    "a copy a tool carries inside itself",
  );
  assert.equal(
    inScope(
      f({
        fix: "unverified",
        packageName: "undici",
        location:
          "/usr/local/lib/node_modules/npm/node_modules/undici/package.json",
      }),
    ),
    false,
    "npm's own packages in an image",
  );
  assert.equal(
    inScope(
      f({
        ecosystem: "PyPI",
        packageName: "pyyaml",
        location:
          "/app/.venv/lib/python3.9/site-packages/pyyaml-5.3.1.dist-info/METADATA",
      }),
    ),
    true,
    "the app's own Python dependency",
  );
  assert.equal(inScope(f({ fix: "rebuild" })), false, "the base system");
  assert.equal(inScope(f({ fix: "none" })), false, "nothing to apply");
  const image = {
    fix: "update",
    location: "/app/node_modules/next/package.json",
  };
  assert.equal(inScope(f({ ...image, packageName: "next" })), true);
  assert.equal(
    inScope(f({ ...image, ecosystem: "Alpine:v3.21", packageName: "openssl" })),
    false,
    "an image's system packages",
  );
  assert.equal(
    inScope(
      f({
        fix: "newer_tag",
        ecosystem: "Go",
        packageName: "stdlib",
        location: "/usr/local/bin/gosu",
      }),
    ),
    false,
    "the Go toolchain inside a vendor binary",
  );
});

test("isActionable: a newer build counts only once it is known to fix it", () => {
  const f = {
    ecosystem: "npm",
    packageName: "next",
    location: "/app/node_modules/next/package.json",
    level: "critical",
  };
  assert.equal(isActionable({ ...f, fix: "update" }), true);
  assert.equal(isActionable({ ...f, fix: "upstream" }), false);
  assert.equal(isActionable({ ...f, fix: "unverified" }), false);
  assert.equal(inScope({ ...f, fix: "upstream" }), true, "still listed");
});

test("isActionable: critical or attacked, and in scope", () => {
  const f = {
    fix: "code",
    ecosystem: "npm",
    packageName: "minimist",
    location: "/app/node_modules/minimist/package.json",
  };
  assert.equal(isActionable({ ...f, level: "critical" }), true);
  assert.equal(isActionable({ ...f, level: "exploited" }), true);
  assert.equal(isActionable({ ...f, level: "high" }), false, "listed only");
  assert.equal(
    isActionable({ ...f, fix: "deplo", level: "exploited" }),
    false,
    "out of scope even when attacked",
  );
});
