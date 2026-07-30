import { test } from "node:test";
import assert from "node:assert/strict";

import {
  failedFileDraft,
  fileDraftIsDirty,
  loadingFileDraft,
  pendingFileWrite,
  storageFileDraft,
  type StorageFileDraft,
} from "./storage-file-model";

/**
 * A File storage entry's content box. The tests that matter are about what the
 * SAVE touches: a File entry writes a real file on the app's server, so "when do
 * we write, and to which path" is the whole safety story.
 */

const editable = (p: Partial<StorageFileDraft> = {}): StorageFileDraft => ({
  path: "config.toml",
  status: "editable",
  saved: "a = 1",
  draft: "a = 1",
  exists: true,
  message: "",
  ...p,
});

/* ---- what the server's answer means -------------------------------- */

test("an existing text file opens with its own contents", () => {
  const d = storageFileDraft({ path: "config.toml", state: "text", text: "a = 1" });
  assert.equal(d.status, "editable");
  assert.equal(d.exists, true);
  assert.equal(d.draft, "a = 1");
  assert.equal(d.saved, d.draft, "an untouched file is not unsaved work");
});

test("a path with nothing behind it is an empty file to write, not an error", () => {
  const d = storageFileDraft({ path: "config.toml", state: "new", text: "" });
  assert.equal(d.status, "editable");
  assert.equal(d.exists, false);
  assert.equal(d.draft, "");
});

test("a re-read keeps what the user had already typed", () => {
  // Typing content, then correcting the path, must not throw the content away.
  const d = storageFileDraft(
    { path: "nginx.conf", state: "new", text: "" },
    "server { }",
  );
  assert.equal(d.draft, "server { }");
  assert.equal(d.saved, "");
  assert.equal(d.path, "nginx.conf", "the draft now belongs to the NEW path");
});

test("a folder, a binary and an oversized file each say so and stay mounted", () => {
  for (const state of ["folder", "binary", "too-large"]) {
    const d = storageFileDraft({ path: "x", state, text: "" });
    assert.equal(d.status, "blocked", state);
    assert.match(d.message, /Files tab/, state);
    assert.ok(!d.message.includes("…"), "no ellipsis in UI copy");
  }
});

test("an answer this build doesn't know is blocked, never silently editable", () => {
  const d = storageFileDraft({ path: "x", state: "something-new", text: "" });
  assert.equal(d.status, "blocked");
  assert.ok(d.message.length > 0);
});

/* ---- unsaved work --------------------------------------------------- */

test("typed content counts as unsaved work; an untouched file does not", () => {
  assert.equal(fileDraftIsDirty(editable(), "config.toml"), false);
  assert.equal(
    fileDraftIsDirty(editable({ draft: "a = 2" }), "config.toml"),
    true,
  );
  // Read for another path, still loading, blocked or failed: nothing to save.
  assert.equal(
    fileDraftIsDirty(editable({ draft: "a = 2" }), "other.toml"),
    false,
  );
  assert.equal(fileDraftIsDirty(loadingFileDraft("config.toml"), "config.toml"), false);
  assert.equal(fileDraftIsDirty(undefined, "config.toml"), false);
});

/* ---- what the save writes ------------------------------------------- */

test("an unchanged file that already exists is not rewritten", () => {
  assert.equal(pendingFileWrite(editable(), "config.toml"), null);
});

test("changed content is written", () => {
  assert.equal(pendingFileWrite(editable({ draft: "a = 2" }), "config.toml"), "a = 2");
});

test("a file that isn't there yet is created even when it is empty", () => {
  // The reason this rule exists: Docker answers a missing bind source by
  // inventing an empty DIRECTORY at the mount path, so the app would boot with a
  // folder where its config file should be — silently.
  assert.equal(
    pendingFileWrite(editable({ exists: false, saved: "", draft: "" }), "config.toml"),
    "",
  );
});

test("content read for a different path is never written", () => {
  // The user typed content for config.toml, then edited the path. Writing this
  // to nginx.conf would truncate a file nobody looked at.
  assert.equal(pendingFileWrite(editable({ draft: "a = 2" }), "nginx.conf"), null);
  assert.equal(pendingFileWrite(undefined, "config.toml"), null);
});

test("what deplo could not read or cannot edit, it does not touch", () => {
  assert.equal(pendingFileWrite(loadingFileDraft("config.toml"), "config.toml"), null);
  assert.equal(
    pendingFileWrite(failedFileDraft("config.toml", "server unreachable"), "config.toml"),
    null,
  );
  assert.equal(
    pendingFileWrite(
      storageFileDraft({ path: "conf", state: "folder", text: "" }),
      "conf",
    ),
    null,
  );
});
