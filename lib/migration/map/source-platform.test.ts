import { test } from "node:test";
import assert from "node:assert/strict";

import type { SourceApplication, SourceDatabase } from "../model";
import { mapPorts, unsupportedNotes } from "./app-settings";
import { mapSource } from "./app-source";
import { mapDatabase } from "./databases";
import { deploFilesPath, withPanel } from "./source-platform";

test("deploFilesPath reads both platforms' files directories", () => {
  assert.equal(deploFilesPath("../files/conf/app.ini"), "./conf/app.ini");
  assert.equal(deploFilesPath("../files"), ".");
  assert.equal(
    deploFilesPath("/data/coolify/services/ewc08w0/redis.conf"),
    "./redis.conf",
  );
  assert.equal(deploFilesPath("/data/coolify/applications/ewc08w0"), ".");
  assert.equal(
    deploFilesPath("/etc/dokploy/compose/shop-abc123/files/conf/app.ini"),
    "./conf/app.ini",
  );
  // A bind under the panel's own directory is deleted with the panel, so it moves into Deplo's files directory.
  assert.equal(deploFilesPath("/etc/dokploy/mxbind"), "./mxbind");
  assert.equal(deploFilesPath("/data/coolify/backups/x"), "./backups/x");
  assert.equal(deploFilesPath("/etc/dokployer/x"), null);
  assert.equal(deploFilesPath("/var/lib/app"), null);
  assert.equal(deploFilesPath("app-data"), null);
});

test("withPanel puts the source product's name in every slot", () => {
  assert.equal(
    withPanel("Runs on {panel}. {panel} never says the password.", "Coolify"),
    "Runs on Coolify. Coolify never says the password.",
  );
  assert.equal(withPanel("no slot here", "Coolify"), "no slot here");
});

// A product name written into a note is how a Coolify migration ends up telling somebody what happened "on Dokploy".
test("no mapper note names a product", () => {
  const notes = [
    ...mapSource({ sourceType: "drop" } as SourceApplication).notes,
    ...mapSource({ sourceType: "docker" } as SourceApplication).notes,
    ...mapDatabase("postgres", {
      name: "db",
      dockerImage: "postgres",
    } as SourceDatabase).notes,
    ...mapPorts({
      ports: [{ portId: "p1", publishedPort: 80, targetPort: 80 }],
    } as SourceApplication).notes,
    ...unsupportedNotes({
      replicas: 3,
      placementSwarm: { x: 1 },
    } as SourceApplication),
  ];
  assert.ok(notes.length > 0);
  assert.doesNotMatch(notes.join(" "), /Dokploy|Coolify/);
});
