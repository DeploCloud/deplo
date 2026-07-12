import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeRel, resolveWithinRoot } from "./service-files";

/**
 * The file explorer hands user-supplied relative paths straight to the
 * filesystem, so its two containment guards are the whole security story: a
 * traversal must be rejected before it forms a path, and a path that resolves
 * (through symlinks) outside the sandbox must be refused. Both are tested here
 * against a real temp tree — string checks alone wouldn't catch the symlink
 * escape, which is the one that matters.
 */

test("normalizeRel: cleans separators and trims slashes", () => {
  assert.equal(normalizeRel("a/b/c"), "a/b/c");
  assert.equal(normalizeRel("/a//b/"), "a/b");
  assert.equal(normalizeRel("a\\b\\c"), "a/b/c"); // backslashes folded
  assert.equal(normalizeRel(""), "");
  assert.equal(normalizeRel("."), "");
});

test("normalizeRel: rejects any .. traversal segment", () => {
  assert.throws(() => normalizeRel("../etc/passwd"), /traversal/);
  assert.throws(() => normalizeRel("a/../../b"), /traversal/);
  assert.throws(() => normalizeRel("a/b/.."), /traversal/);
  assert.throws(() => normalizeRel("..\\windows"), /traversal/); // folded then caught
});

test("resolveWithinRoot: resolves a real file inside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-ok-"));
  try {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "config.toml"), "x");
    const abs = await resolveWithinRoot(root, "sub/config.toml");
    assert.ok(abs.endsWith(`${join("sub", "config.toml")}`));
    // The root itself ("" / ".") resolves to the root.
    assert.equal(await resolveWithinRoot(root, ""), await resolveWithinRoot(root, "."));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveWithinRoot: refuses a symlink pointing outside the sandbox", async () => {
  const base = await mkdtemp(join(tmpdir(), "pf-link-"));
  try {
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret"), "nope");
    // A planted symlink inside the root that points at a sibling dir.
    await symlink(outside, join(root, "escape"));
    // Reading *through* the symlink must be blocked — realpath lands outside.
    await assert.rejects(
      () => resolveWithinRoot(root, "escape/secret"),
      /escapes/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("resolveWithinRoot: a sibling dir with the root as a name prefix can't match", async () => {
  const base = await mkdtemp(join(tmpdir(), "pf-sib-"));
  try {
    const root = join(base, "proj");
    const sibling = join(base, "proj-evil");
    await mkdir(root, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await symlink(sibling, join(root, "link"));
    // `proj-evil` starts with `proj` but the separator boundary rejects it.
    await assert.rejects(() => resolveWithinRoot(root, "link"), /escapes/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
