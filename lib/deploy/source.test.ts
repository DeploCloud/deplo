import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  planDeploySource,
  devWorkspaceDeployAllowed,
  normalizeRootRel,
  isExplicitRoot,
  resolveBuildDir,
  RootDirectoryNotFound,
} from "./source";
import type { GitRepo, UploadArchive } from "../types";

const repo: GitRepo = { provider: "git", url: "https://x/y", repo: "x/y", branch: "main" };
const upload: UploadArchive = { id: "u1", filename: "a.tar.gz", path: "/p", size: 1, uploadedAt: "now" };

// ---- planDeploySource: which source a deployment builds from ----

test("dev-workspace intent overrides the project's own source (checked FIRST)", () => {
  // A git project asked to deploy its workspace must NOT clone.
  assert.deepEqual(
    planDeploySource({ source: "github", repo }, { buildSource: "dev-workspace" }),
    { kind: "dev-workspace" },
  );
  // Even an upload project: workspace wins.
  assert.deepEqual(
    planDeploySource({ source: "upload", upload }, { buildSource: "dev-workspace" }),
    { kind: "dev-workspace" },
  );
});

test("docker-image needs an image set, and carries it", () => {
  assert.deepEqual(
    planDeploySource({ source: "docker-image", dockerImage: "nginx:1" }, {}),
    { kind: "docker-image", image: "nginx:1" },
  );
  // docker-image source with no image falls through to none.
  assert.deepEqual(planDeploySource({ source: "docker-image" }, {}), { kind: "none" });
});

test("git wins when a repo is present, and carries the repo", () => {
  assert.deepEqual(planDeploySource({ source: "github", repo }, {}), {
    kind: "git",
    repo,
  });
});

test("upload only when source is upload AND an archive is present", () => {
  assert.deepEqual(planDeploySource({ source: "upload", upload }, {}), {
    kind: "upload",
    upload,
  });
  assert.deepEqual(planDeploySource({ source: "upload" }, {}), { kind: "none" });
});

test("a repo present alongside an upload still prefers git (repo check first)", () => {
  // Mirrors the engine's historical else-if order: repo before upload.
  assert.deepEqual(planDeploySource({ source: "upload", repo, upload }, {}), {
    kind: "git",
    repo,
  });
});

test("nothing deployable → none", () => {
  assert.deepEqual(planDeploySource({ source: "git" }, {}), { kind: "none" });
});

// ---- devWorkspaceDeployAllowed: the guard ----

test("dev-workspace deploy is allowed only for built (git/upload) services", () => {
  assert.equal(devWorkspaceDeployAllowed({ usesComposeStack: false, source: "github" }), true);
  assert.equal(devWorkspaceDeployAllowed({ usesComposeStack: false, source: "upload" }), true);
  assert.equal(devWorkspaceDeployAllowed({ usesComposeStack: true, source: "compose" }), false);
  assert.equal(devWorkspaceDeployAllowed({ usesComposeStack: false, source: "docker-image" }), false);
});

// ---- normalizeRootRel / isExplicitRoot: pure path normalisation ----

test("normalizeRootRel: backslashes → slashes, leading ./ and / stripped", () => {
  assert.equal(normalizeRootRel("apps\\web"), "apps/web");
  assert.equal(normalizeRootRel("./apps/web"), "apps/web");
  assert.equal(normalizeRootRel("/apps/web"), "apps/web");
  // "", ".", null, undefined all collapse to "" — the leading-dot strip turns
  // the "." fallback into "". (Faithful to the original inline normalisation.)
  assert.equal(normalizeRootRel(""), "");
  assert.equal(normalizeRootRel(null), "");
  assert.equal(normalizeRootRel(undefined), "");
  assert.equal(normalizeRootRel("."), "");
});

test("isExplicitRoot: only a real subdirectory counts", () => {
  assert.equal(isExplicitRoot("apps/web"), true);
  assert.equal(isExplicitRoot("."), false);
  assert.equal(isExplicitRoot(""), false);
  // The normalised forms of "" / "." / null all read as non-explicit.
  assert.equal(isExplicitRoot(normalizeRootRel(".")), false);
  assert.equal(isExplicitRoot(normalizeRootRel("apps")), true);
});

// ---- resolveBuildDir: the one shared rootDirectory containment ----

test("resolveBuildDir: no rootDirectory → the tree root", async () => {
  const root = await mkdtemp(join(tmpdir(), "deplo-src-"));
  try {
    const got = await resolveBuildDir({ root, rootDirectory: "", failOnMissing: true });
    assert.equal(got, await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveBuildDir: existing subdirectory is contained and returned", async () => {
  const root = await mkdtemp(join(tmpdir(), "deplo-src-"));
  try {
    await mkdir(join(root, "apps", "web"), { recursive: true });
    const got = await resolveBuildDir({ root, rootDirectory: "apps/web", failOnMissing: true });
    assert.equal(got, await realpath(join(root, "apps", "web")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveBuildDir: explicit-but-missing root hard-fails when failOnMissing", async () => {
  const root = await mkdtemp(join(tmpdir(), "deplo-src-"));
  try {
    await assert.rejects(
      () => resolveBuildDir({ root, rootDirectory: "nope", failOnMissing: true, notFoundMessage: "boom" }),
      (e: unknown) => e instanceof RootDirectoryNotFound && /boom/.test((e as Error).message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveBuildDir: explicit-but-missing root falls back silently when !failOnMissing (upload)", async () => {
  const root = await mkdtemp(join(tmpdir(), "deplo-src-"));
  try {
    const got = await resolveBuildDir({ root, rootDirectory: "nope", failOnMissing: false });
    assert.equal(got, await realpath(root)); // upload behaviour: build the root
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveBuildDir: a symlink escaping the tree is rejected (contained to root)", async () => {
  const root = await mkdtemp(join(tmpdir(), "deplo-src-"));
  const outside = await mkdtemp(join(tmpdir(), "deplo-out-"));
  try {
    // Plant a symlink inside the tree pointing OUT of it.
    await symlink(outside, join(root, "escape"));
    const got = await resolveBuildDir({ root, rootDirectory: "escape", failOnMissing: false });
    // safeBuildDir refuses the escape and falls back to the canonical root.
    assert.equal(got, await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
