import { test } from "node:test";
import assert from "node:assert/strict";

import { appDisk, appKeepsVolume } from "./failover-copy";

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
