import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRel,
  storageFileReadError,
  storageFileStateForError,
} from "./app-files";
import { AgentUnreachableError } from "../infra/agent-client/errors";

test("normalizeRel: cleans separators and trims slashes", () => {
  assert.equal(normalizeRel("a/b/c"), "a/b/c");
  assert.equal(normalizeRel("/a//b/"), "a/b");
  assert.equal(normalizeRel("a\\b\\c"), "a/b/c");
  assert.equal(normalizeRel(""), "");
  assert.equal(normalizeRel("."), "");
});

test("normalizeRel: rejects any .. traversal segment", () => {
  assert.throws(() => normalizeRel("../etc/passwd"), /traversal/);
  assert.throws(() => normalizeRel("a/../../b"), /traversal/);
  assert.throws(() => normalizeRel("a/b/.."), /traversal/);
  assert.throws(() => normalizeRel("..\\windows"), /traversal/);
});

test("a path with nothing behind it reads as a new file, not a failure", () => {
  const notFound = Object.assign(
    new Error(
      "read config.toml: open /data/stacks/files/shop/config.toml: no such file or directory",
    ),
    { code: 5 },
  );
  assert.equal(storageFileStateForError(notFound), "new");
});

test("a directory at the entry's path is reported as a folder", () => {
  const notAFile = Object.assign(new Error("not a file"), { code: 3 });
  assert.equal(storageFileStateForError(notAFile), "folder");
});

test("anything else stays an error - an unreachable server is not an empty file", () => {
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
  const raw = new AgentUnreachableError(
    "14 UNAVAILABLE: connect ECONNREFUSED 10.0.0.4:9443 (pin ab12cd34)",
    14,
  );
  const shown = storageFileReadError(raw);
  assert.match(shown.message, /didn't answer/);
  assert.ok(!shown.message.includes("9443"));
  assert.ok(!shown.message.includes("ab12cd34"));
  assert.equal(shown.cause, raw, "the original stays available server-side");
  assert.equal((shown as { code?: unknown }).code, undefined);

  const other = storageFileReadError(new Error("boom"));
  assert.match(other.message, /couldn't read this file/);
});
