import { test } from "node:test";
import assert from "node:assert/strict";

import { validateVolumes, deriveVolumeName } from "./projects";
import type { VolumeMount } from "../types";

/** A volume row with sensible defaults; override per case. */
function vol(p: Partial<VolumeMount>): VolumeMount {
  return { id: "vol_x", name: "", mountPath: "/data", readOnly: false, ...p };
}

test("accepts a clean named volume and keeps its id", () => {
  const out = validateVolumes([vol({ id: "vol_keep", name: "data", mountPath: "/data" })], null);
  assert.deepEqual(out, [
    { id: "vol_keep", name: "data", mountPath: "/data", readOnly: false },
  ]);
});

test("derives the name from the mount path when blank", () => {
  const out = validateVolumes([vol({ name: "", mountPath: "/var/data" })], null);
  assert.equal(out?.[0].name, "var-data");
});

test("lowercases the name", () => {
  const out = validateVolumes([vol({ name: "MyData", mountPath: "/d" })], null);
  assert.equal(out?.[0].name, "mydata");
});

test("empty list normalizes to null (byte-identical render)", () => {
  assert.equal(validateVolumes([], null), null);
});

test("rejects relative paths", () => {
  assert.throws(() => validateVolumes([vol({ mountPath: "data" })], null), /absolute/);
});

test("rejects paths containing a colon (flag smuggling)", () => {
  assert.throws(() => validateVolumes([vol({ mountPath: "/data:ro" })], null), /":"/);
});

test("rejects paths with whitespace", () => {
  assert.throws(() => validateVolumes([vol({ mountPath: "/my data" })], null), /spaces/);
});

test("rejects '..' traversal", () => {
  assert.throws(() => validateVolumes([vol({ mountPath: "/a/../b" })], null), /".."/);
});

test("rejects reserved system prefixes", () => {
  for (const p of ["/etc", "/etc/passwd", "/proc", "/usr/lib", "/var/run/x"]) {
    assert.throws(() => validateVolumes([vol({ mountPath: p })], null), /reserved/, p);
  }
});

test("rejects a name with illegal characters or too long", () => {
  assert.throws(() => validateVolumes([vol({ name: "bad name", mountPath: "/d" })], null), /lowercase/);
  assert.throws(() => validateVolumes([vol({ name: "a".repeat(41), mountPath: "/d" })], null), /max 40/);
});

test("rejects duplicate mount paths", () => {
  assert.throws(
    () =>
      validateVolumes(
        [vol({ name: "a", mountPath: "/data" }), vol({ name: "b", mountPath: "/data" })],
        null,
      ),
    /Duplicate mount path/,
  );
});

test("rejects duplicate names", () => {
  assert.throws(
    () =>
      validateVolumes(
        [vol({ name: "data", mountPath: "/x" }), vol({ name: "data", mountPath: "/y" })],
        null,
      ),
    /Duplicate volume name/,
  );
});

test("rejects a mount path that collides with a template config file", () => {
  assert.throws(
    () => validateVolumes([vol({ mountPath: "/app/config" })], [{ filePath: "/app/config" }]),
    /config file/,
  );
  // Also when the volume would shadow a directory holding a config file.
  assert.throws(
    () => validateVolumes([vol({ mountPath: "/app" })], [{ filePath: "/app/config.yml" }]),
    /config file/,
  );
});

test("mints an id when a row has none", () => {
  const out = validateVolumes([vol({ id: "", name: "data", mountPath: "/d" })], null);
  assert.match(out![0].id, /^vol_/);
});

test("deriveVolumeName falls back to 'data' for the root path", () => {
  assert.equal(deriveVolumeName("/"), "data");
});

/* ------------------------------------------------------------------ */
/* Host bind mounts (type: "host")                                     */
/* ------------------------------------------------------------------ */

test("accepts a host bind mount and keeps type + hostPath", () => {
  const out = validateVolumes(
    [vol({ id: "vol_h", type: "host", hostPath: "/srv/data", mountPath: "/data" })],
    null,
  );
  assert.deepEqual(out, [
    {
      id: "vol_h",
      type: "host",
      name: "data",
      hostPath: "/srv/data",
      mountPath: "/data",
      readOnly: false,
    },
  ]);
});

test("host mount: rejects a relative host path", () => {
  assert.throws(
    () => validateVolumes([vol({ type: "host", hostPath: "srv/data", mountPath: "/data" })], null),
    /Host path .*absolute/,
  );
});

test("host mount: rejects a host path with a colon (flag smuggling)", () => {
  assert.throws(
    () => validateVolumes([vol({ type: "host", hostPath: "/srv:data", mountPath: "/data" })], null),
    /Host path/,
  );
});

test("host mount: rejects '..' traversal in the host path", () => {
  assert.throws(
    () => validateVolumes([vol({ type: "host", hostPath: "/srv/../etc", mountPath: "/data" })], null),
    /Host path must not contain/,
  );
});

test("host mount: the host SOURCE may point at an otherwise-reserved path", () => {
  // RESERVED_MOUNT_PREFIXES guard the in-container TARGET, not the host source.
  const out = validateVolumes(
    [vol({ type: "host", hostPath: "/etc/myapp", mountPath: "/data" })],
    null,
  );
  assert.equal(out?.[0].hostPath, "/etc/myapp");
});

test("host mount: the in-container mountPath is still reserved-checked", () => {
  assert.throws(
    () => validateVolumes([vol({ type: "host", hostPath: "/srv/x", mountPath: "/etc" })], null),
    /reserved/,
  );
});

test("host mount: does not enforce docker-name rules and ignores name dupes", () => {
  // Two host mounts can share a derived name (no top-level volumes entry), but
  // their mountPaths must still differ.
  const out = validateVolumes(
    [
      vol({ type: "host", hostPath: "/a", mountPath: "/data" }),
      vol({ type: "host", hostPath: "/b", mountPath: "/data2" }),
    ],
    null,
  );
  assert.equal(out?.length, 2);
});
