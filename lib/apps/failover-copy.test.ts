import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import {
  appDisk,
  appKeepsVolume,
  copiesActivity,
  type CopyRow,
} from "./failover-copy";

const file = (projectPath: string) => ({ type: "app", projectPath });

test("a File whose content Deplo holds fails over with the stack", () => {
  const app = {
    volumes: [file("conf/app.toml")],
    mounts: [{ filePath: "conf/app.toml" }],
  };
  assert.equal(appKeepsVolume(app), false);
  assert.equal(appDisk(app), null);
});

test("a File that exists only on its server keeps the App there, like a Volume", () => {
  // Written from the Storage editor, or by the App itself: nothing but that disk holds it.
  assert.equal(appDisk({ volumes: [file("data.sqlite")] }), "volume");
  assert.equal(
    appDisk({
      volumes: [file("conf/app.toml"), file("uploads")],
      mounts: [{ filePath: "conf/app.toml" }],
    }),
    "volume",
  );
  // The path is compared as it is stored on both sides.
  assert.equal(
    appDisk({
      volumes: [file("./conf/app.toml")],
      mounts: [{ filePath: "conf/app.toml" }],
    }),
    null,
  );
});

test("a Volume and a Bind are what they were", () => {
  assert.equal(appDisk({ volumes: [{ type: "named" }] }), "volume");
  assert.equal(appDisk({ volumes: [{ type: null }] }), "volume");
  assert.equal(appDisk({ volumes: [{ type: "host" }] }), "bind");
  assert.equal(appDisk({ volumes: [] }), null);
});

describe("what Activity says when copies start or stop letting an App move", () => {
  const row = (state: CopyRow["state"]): CopyRow => ({
    server: "eu-2",
    state,
    lastCopyAt: null,
    behindSeconds: null,
    bytes: 0,
    error: "",
  });
  it("a whole copy that is behind can move it, and says what it lacks rather than 0 up to date", () => {
    const said = copiesActivity(
      "fise",
      "eu-1",
      [row("Behind"), row("Behind")],
      true,
    );
    assert.equal(
      said,
      "fise: no copy is up to date yet. It can still move if eu-1 goes off, without the writes no copy has received.",
    );
    assert.doesNotMatch(said, /0 of 2/);
  });
  it("an up-to-date copy says how many and that it can move", () => {
    assert.equal(
      copiesActivity("fise", "eu-1", [row("Up to date"), row("Behind")], true),
      "fise: Copies: 1 of 2 up to date. It can move if eu-1 goes off.",
    );
  });
  it("a copy that cannot move it says only how it stands", () => {
    assert.equal(
      copiesActivity(
        "fise",
        "eu-1",
        [row("Not copied"), row("Not copied")],
        false,
      ),
      "fise: Not copied yet: this App cannot move if eu-1 goes off",
    );
  });
});
