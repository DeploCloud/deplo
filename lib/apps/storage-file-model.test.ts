import { test } from "node:test";
import assert from "node:assert/strict";

import {
  failedFileDraft,
  fileDraftIsDirty,
  loadingFileDraft,
  pendingFileWrite,
  storageFileDraft,
  unpathedFileDraft,
  type StorageFileDraft,
} from "./storage-file-model";
import { effectiveMountPath, volumeProblem } from "./volume-model";
import type { VolumeMount } from "../types/container";

const editable = (p: Partial<StorageFileDraft> = {}): StorageFileDraft => ({
  path: "config.toml",
  status: "editable",
  saved: "a = 1",
  draft: "a = 1",
  exists: true,
  message: "",
  ...p,
});

test("an existing text file opens with its own contents", () => {
  const d = storageFileDraft({
    path: "config.toml",
    state: "text",
    text: "a = 1",
  });
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
    assert.match(d.message, /stays mounted/, state);
    assert.ok(!d.message.includes("…"), "no ellipsis in UI copy");
  }
});

test("an answer this build doesn't know is blocked, never silently editable", () => {
  const d = storageFileDraft({ path: "x", state: "something-new", text: "" });
  assert.equal(d.status, "blocked");
  assert.ok(d.message.length > 0);
});

test("typed content counts as unsaved work; an untouched file does not", () => {
  assert.equal(fileDraftIsDirty(editable(), "config.toml"), false);
  assert.equal(
    fileDraftIsDirty(editable({ draft: "a = 2" }), "config.toml"),
    true,
  );
  assert.equal(
    fileDraftIsDirty(editable({ draft: "a = 2" }), "other.toml"),
    false,
  );
  assert.equal(
    fileDraftIsDirty(loadingFileDraft("config.toml"), "config.toml"),
    false,
  );
  assert.equal(fileDraftIsDirty(undefined, "config.toml"), false);
});

test("an unchanged file that already exists is not rewritten", () => {
  assert.equal(pendingFileWrite(editable(), "config.toml"), null);
});

test("changed content is written", () => {
  assert.equal(
    pendingFileWrite(editable({ draft: "a = 2" }), "config.toml"),
    "a = 2",
  );
});

test("a file that isn't there yet is created even when it is empty", () => {
  // Docker answers a missing bind source by inventing an empty directory there.
  assert.equal(
    pendingFileWrite(
      editable({ exists: false, saved: "", draft: "" }),
      "config.toml",
    ),
    "",
  );
});

test("content read for a different path is never written", () => {
  assert.equal(
    pendingFileWrite(editable({ draft: "a = 2" }), "nginx.conf"),
    null,
  );
  assert.equal(pendingFileWrite(undefined, "config.toml"), null);
});

test("the box can be written in before the entry names a file", () => {
  const d = unpathedFileDraft("server { }");
  assert.equal(d.status, "editable");
  assert.equal(d.path, "");
  assert.equal(d.draft, "server { }");
  assert.equal(d.saved, "");
});

test("text typed with no path yet is unsaved work, so leaving the page warns", () => {
  assert.equal(fileDraftIsDirty(unpathedFileDraft("server { }"), ""), true);
  assert.equal(fileDraftIsDirty(unpathedFileDraft(""), ""), false);
});

test("nothing is ever written until the entry names a file", () => {
  assert.equal(pendingFileWrite(unpathedFileDraft("server { }"), ""), null);
  assert.equal(
    pendingFileWrite(editable({ path: "", saved: "", exists: false }), ""),
    null,
  );
});

test("naming the file afterwards carries the typed text over", () => {
  const held = unpathedFileDraft("server { }");
  const named = storageFileDraft(
    { path: "nginx.conf", state: "new", text: "" },
    held.draft,
  );
  assert.equal(named.draft, "server { }");
  assert.equal(pendingFileWrite(named, "nginx.conf"), "server { }");
});

test("the whole write-then-name flow: nothing is saved until the entry is complete", () => {
  const row: VolumeMount = {
    id: "vol_1",
    type: "app",
    name: "",
    mountPath: "",
    readOnly: false,
  };
  assert.equal(volumeProblem(row, "/app")?.field, "source");

  const typed = unpathedFileDraft("server { listen 80; }");
  assert.equal(fileDraftIsDirty(typed, ""), true);
  assert.equal(pendingFileWrite(typed, ""), null);
  assert.equal(volumeProblem(row, "/app")?.field, "source", "still blocked");

  const named = { ...row, projectPath: "nginx.conf" };
  assert.equal(
    volumeProblem(named, "/app"),
    null,
    "complete: the path derives",
  );
  assert.equal(effectiveMountPath(named, "/app"), "/app/nginx.conf");

  const read = storageFileDraft(
    { path: "nginx.conf", state: "new", text: "" },
    typed.draft,
  );
  assert.equal(pendingFileWrite(read, "nginx.conf"), "server { listen 80; }");

  assert.equal(volumeProblem(named, null)?.field, "mountPath");
});

test("what Deplo could not read or cannot edit, it does not touch", () => {
  assert.equal(
    pendingFileWrite(loadingFileDraft("config.toml"), "config.toml"),
    null,
  );
  assert.equal(
    pendingFileWrite(
      failedFileDraft("config.toml", "server unreachable"),
      "config.toml",
    ),
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
