import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeRel,
  resolveWithinRoot,
  storageFileReadError,
  storageFileStateForError,
} from "./app-files";
import { AgentUnreachableError } from "../infra/agent-client";

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
    assert.equal(
      await resolveWithinRoot(root, ""),
      await resolveWithinRoot(root, "."),
    );
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

/* ---- the Storage editor's read -------------------------------------- */

test("a path with nothing behind it reads as a new file, not a failure", () => {
  // The agent's NOT_FOUND covers the file, a missing parent dir, and an app that
  // has no files dir yet — all three are "there is nothing there to read", which
  // for an editor whose job is to CREATE that file is the normal case.
  const notFound = Object.assign(
    new Error(
      "read config.toml: open /data/stacks/files/shop/config.toml: no such file or directory",
    ),
    { code: 5 }, // grpc NOT_FOUND
  );
  assert.equal(storageFileStateForError(notFound), "new");
});

test("a directory at the entry's path is reported as a folder", () => {
  const notAFile = Object.assign(new Error("not a file"), { code: 3 }); // INVALID_ARGUMENT
  assert.equal(storageFileStateForError(notAFile), "folder");
});

test("anything else stays an error — an unreachable server is not an empty file", () => {
  // Reporting "new" here would show an empty editor for a file we never read,
  // and the next save would overwrite it with whatever is on screen.
  assert.equal(
    storageFileStateForError(new Error("14 UNAVAILABLE: no connection")),
    null,
  );
  assert.equal(
    storageFileStateForError(
      Object.assign(new Error("agent unreachable"), { code: 14 }),
    ),
    null,
  );
  // A different INVALID_ARGUMENT (a rejected path, say) is not a folder.
  assert.equal(
    storageFileStateForError(
      Object.assign(new Error("path escapes the project files directory"), {
        code: 3,
      }),
    ),
    null,
  );
  assert.equal(storageFileStateForError("something odd"), null);
});

test("a read that failed says what happened, without leaking the dial target", () => {
  // A gRPC transport error carries the address and the pinned cert fingerprint;
  // the editor shows this message verbatim next to "Try again", so the curated
  // copy must carry the meaning and none of the internals.
  const raw = new AgentUnreachableError(
    "14 UNAVAILABLE: connect ECONNREFUSED 10.0.0.4:9443 (pin ab12cd34)",
    14,
  );
  const shown = storageFileReadError(raw);
  assert.match(shown.message, /didn't answer/);
  assert.ok(!shown.message.includes("9443"));
  assert.ok(!shown.message.includes("ab12cd34"));
  assert.equal(shown.cause, raw, "the original stays available server-side");
  // A plain Error (no infrastructure code) is what the GraphQL mask forwards.
  assert.equal((shown as { code?: unknown }).code, undefined);

  const other = storageFileReadError(new Error("boom"));
  assert.match(other.message, /couldn't read this file/);
});
