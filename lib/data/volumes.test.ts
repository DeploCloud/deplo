import { test } from "node:test";
import assert from "node:assert/strict";

import { validateVolumes, deriveVolumeName } from "./apps";
import type { VolumeMount } from "../types";

/** A volume row with sensible defaults; override per case. */
function vol(p: Partial<VolumeMount>): VolumeMount {
  return { id: "vol_x", name: "", mountPath: "/data", readOnly: false, ...p };
}

test("accepts a clean named volume and keeps its id", () => {
  const out = validateVolumes(
    [vol({ id: "vol_keep", name: "data", mountPath: "/data" })],
    null,
  );
  assert.deepEqual(out, [
    { id: "vol_keep", name: "data", mountPath: "/data", readOnly: false },
  ]);
});

test("derives the name from the mount path when blank", () => {
  const out = validateVolumes(
    [vol({ name: "", mountPath: "/var/data" })],
    null,
  );
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
  assert.throws(
    () => validateVolumes([vol({ mountPath: "data" })], null),
    /absolute/,
  );
});

test("rejects paths containing a colon (flag smuggling)", () => {
  assert.throws(
    () => validateVolumes([vol({ mountPath: "/data:ro" })], null),
    /":"/,
  );
});

test("rejects paths with whitespace", () => {
  assert.throws(
    () => validateVolumes([vol({ mountPath: "/my data" })], null),
    /spaces/,
  );
});

test("rejects '..' traversal", () => {
  assert.throws(
    () => validateVolumes([vol({ mountPath: "/a/../b" })], null),
    /".."/,
  );
});

test("rejects reserved system prefixes", () => {
  for (const p of ["/etc", "/etc/passwd", "/proc", "/usr/lib", "/var/run/x"]) {
    assert.throws(
      () => validateVolumes([vol({ mountPath: p })], null),
      /reserved/,
      p,
    );
  }
});

test("rejects a name with illegal characters or too long", () => {
  assert.throws(
    () => validateVolumes([vol({ name: "bad name", mountPath: "/d" })], null),
    /lowercase/,
  );
  assert.throws(
    () =>
      validateVolumes([vol({ name: "a".repeat(41), mountPath: "/d" })], null),
    /max 40/,
  );
});

test("rejects duplicate mount paths", () => {
  assert.throws(
    () =>
      validateVolumes(
        [
          vol({ name: "a", mountPath: "/data" }),
          vol({ name: "b", mountPath: "/data" }),
        ],
        null,
      ),
    /Duplicate mount path/,
  );
});

test("rejects duplicate names", () => {
  assert.throws(
    () =>
      validateVolumes(
        [
          vol({ name: "data", mountPath: "/x" }),
          vol({ name: "data", mountPath: "/y" }),
        ],
        null,
      ),
    /Duplicate volume name/,
  );
});

test("rejects a mount path that collides with a template config file", () => {
  assert.throws(
    () =>
      validateVolumes(
        [vol({ mountPath: "/app/config" })],
        [{ filePath: "/app/config" }],
      ),
    /config file/,
  );
  // Also when the volume would shadow a directory holding a config file.
  assert.throws(
    () =>
      validateVolumes(
        [vol({ mountPath: "/app" })],
        [{ filePath: "/app/config.yml" }],
      ),
    /config file/,
  );
});

test("mints an id when a row has none", () => {
  const out = validateVolumes(
    [vol({ id: "", name: "data", mountPath: "/d" })],
    null,
  );
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
    [
      vol({
        id: "vol_h",
        type: "host",
        hostPath: "/srv/data",
        mountPath: "/data",
      }),
    ],
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
    () =>
      validateVolumes(
        [vol({ type: "host", hostPath: "srv/data", mountPath: "/data" })],
        null,
      ),
    /path on the server must be absolute/,
  );
});

test("host mount: rejects a host path with a colon (flag smuggling)", () => {
  assert.throws(
    () =>
      validateVolumes(
        [vol({ type: "host", hostPath: "/srv:data", mountPath: "/data" })],
        null,
      ),
    /path on the server/,
  );
});

test("host mount: rejects '..' traversal in the host path", () => {
  assert.throws(
    () =>
      validateVolumes(
        [vol({ type: "host", hostPath: "/srv/../etc", mountPath: "/data" })],
        null,
      ),
    /path on the server cannot contain "\.\."/,
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
    () =>
      validateVolumes(
        [vol({ type: "host", hostPath: "/srv/x", mountPath: "/etc" })],
        null,
      ),
    /reserved/,
  );
});

test("host mount: keeps a propagation, and leaves the key ABSENT without one", () => {
  const out = validateVolumes(
    [
      vol({
        id: "vol_h",
        type: "host",
        hostPath: "/srv/neon",
        mountPath: "/srv/neon",
        propagation: "rslave",
      }),
    ],
    null,
  );
  assert.deepEqual(out, [
    {
      id: "vol_h",
      type: "host",
      name: "srv-neon",
      hostPath: "/srv/neon",
      mountPath: "/srv/neon",
      readOnly: false,
      propagation: "rslave",
    },
  ]);
  // No propagation ⇒ no key at all, so the row (and the mount line it renders)
  // is byte-identical to one written before the field existed.
  const plain = validateVolumes(
    [vol({ type: "host", hostPath: "/srv/neon", mountPath: "/srv/neon" })],
    null,
  );
  assert.ok(!("propagation" in plain![0]));
});

test("host mount: rejects a propagation outside the closed set", () => {
  assert.throws(
    () =>
      validateVolumes(
        [
          vol({
            type: "host",
            hostPath: "/srv/x",
            mountPath: "/data",
            // Docker's non-recursive modes and anything invented are refused
            // here, not passed through into a compose mount line.
            propagation: "shared" as never,
          }),
        ],
        null,
      ),
    /Unknown mount propagation/,
  );
});

test("propagation is dropped for a named volume and an app-files bind", () => {
  // Docker rejects the option on a managed volume, and a files-dir bind has no
  // submounts. A value left behind by a row that used to be a Bind must not ride
  // along into the mount line.
  const out = validateVolumes(
    [
      vol({ name: "data", mountPath: "/data", propagation: "rslave" }),
      vol({
        type: "app",
        projectPath: "conf.toml",
        mountPath: "/conf.toml",
        propagation: "rslave",
      }),
    ],
    null,
  );
  assert.ok(!out!.some((v) => "propagation" in v));
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

/* ------------------------------------------------------------------ */
/* App-files binds (type: "app")                               */
/* ------------------------------------------------------------------ */

test("accepts a project bind and keeps type + projectPath", () => {
  const out = validateVolumes(
    [
      vol({
        id: "vol_p",
        type: "app",
        projectPath: "config.toml",
        mountPath: "/app/config.toml",
      }),
    ],
    null,
  );
  assert.deepEqual(out, [
    {
      id: "vol_p",
      type: "app",
      // Name is derived from the mount path with non-alnum runs collapsed to "-".
      name: "app-config-toml",
      projectPath: "config.toml",
      mountPath: "/app/config.toml",
      readOnly: false,
    },
  ]);
});

test("project bind: strips a leading './' from the projectPath", () => {
  const out = validateVolumes(
    [vol({ type: "app", projectPath: "./uploads", mountPath: "/uploads" })],
    null,
  );
  assert.equal(out?.[0].projectPath, "uploads");
});

test("project bind: accepts a nested relative path", () => {
  const out = validateVolumes(
    [
      vol({
        type: "app",
        projectPath: "volumes/db/init.sql",
        mountPath: "/init.sql",
      }),
    ],
    null,
  );
  assert.equal(out?.[0].projectPath, "volumes/db/init.sql");
});

test("project bind: rejects a '..' escape (the rename-vuln guard)", () => {
  assert.throws(
    () =>
      validateVolumes(
        [
          vol({
            type: "app",
            projectPath: "../other/data",
            mountPath: "/data",
          }),
        ],
        null,
      ),
    /cannot contain "\.\."/,
  );
  // …including a climb dressed up as same-project self-reference.
  assert.throws(
    () =>
      validateVolumes(
        [
          vol({
            type: "app",
            projectPath: "../demo/appdata",
            mountPath: "/appdata",
          }),
        ],
        null,
      ),
    /cannot contain "\.\."/,
  );
});

test("project bind: rejects an absolute or empty projectPath", () => {
  assert.throws(
    () =>
      validateVolumes(
        [vol({ type: "app", projectPath: "/abs", mountPath: "/data" })],
        null,
      ),
    /must be relative/,
  );
  assert.throws(
    () =>
      validateVolumes(
        [vol({ type: "app", projectPath: "", mountPath: "/data" })],
        null,
      ),
    /must be relative/,
  );
});

test("every mount path refuses `$`, which compose fills in at `up`", () => {
  // `.../${X}` is written into the stack file verbatim and substituted from the
  // env-file, so a Files bind climbs wherever the variable points - out of the app's
  // own directory, with no permission asked for anywhere.
  for (const v of [
    vol({ type: "app", projectPath: "${X}", mountPath: "/data" }),
    vol({ type: "named", name: "data", mountPath: "/data/${X}" }),
    vol({ type: "host", hostPath: "/srv/${X}", mountPath: "/data" }),
  ])
    assert.throws(() => validateVolumes([v], null), /\$/);
});

test("project bind: rejects spaces or a colon in the projectPath", () => {
  assert.throws(
    () =>
      validateVolumes(
        [vol({ type: "app", projectPath: "my file", mountPath: "/data" })],
        null,
      ),
    /spaces, ":" or "\$"/,
  );
  assert.throws(
    () =>
      validateVolumes(
        [vol({ type: "app", projectPath: "a:b", mountPath: "/data" })],
        null,
      ),
    /spaces, ":" or "\$"/,
  );
});

/* ------------------------------------------------------------------ */
/* Compose stacks: the service a volume mounts into                    */
/* (a compose app configures storage in deplo, not by editing YAML)    */
/* ------------------------------------------------------------------ */

test("compose: keeps a service the compose declares", () => {
  const out = validateVolumes(
    [
      vol({
        name: "pgdata",
        service: "db",
        mountPath: "/var/lib/postgresql/data",
      }),
    ],
    null,
    ["web", "db"],
  );
  assert.equal(out![0].service, "db");
});

test("compose: a blank service is stored as null (⇒ the stack's default)", () => {
  const out = validateVolumes([vol({ name: "data", service: "  " })], null, [
    "web",
  ]);
  assert.equal(out![0].service, undefined);
});

test("compose: rejects a service the compose does not declare", () => {
  assert.throws(
    () =>
      validateVolumes([vol({ name: "data", service: "worker" })], null, [
        "web",
      ]),
    /not in this app's compose file/,
  );
});

test("single-container: the service field is dropped, not stored", () => {
  const out = validateVolumes(
    [vol({ name: "data", service: "web" })],
    null,
    null,
  );
  assert.equal(out![0].service, undefined);
});

test("compose: two services may each mount their own /data", () => {
  const out = validateVolumes(
    [
      vol({ id: "v1", name: "webdata", service: "web", mountPath: "/data" }),
      vol({ id: "v2", name: "dbdata", service: "db", mountPath: "/data" }),
    ],
    null,
    ["web", "db"],
  );
  assert.equal(out!.length, 2);
});

test("compose: the SAME service may not mount /data twice", () => {
  assert.throws(
    () =>
      validateVolumes(
        [
          vol({ id: "v1", name: "a", service: "web", mountPath: "/data" }),
          vol({ id: "v2", name: "b", service: "web", mountPath: "/data" }),
        ],
        null,
        ["web", "db"],
      ),
    /Duplicate mount path/,
  );
});
