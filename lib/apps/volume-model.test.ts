import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RESERVED_MOUNT_PREFIXES,
  containerWorkdir,
  derivedMountPath,
  effectiveMountPath,
  switchKind,
  VOLUME_KINDS,
  VOLUME_KIND_ORDER,
  deriveVolumeName,
  filesPathFromMountPath,
  normalizeFilesPath,
  kindOf,
  metaOf,
  namedVolumeTarget,
  volumeProblem,
  volumeReadout,
  volumeSetProblem,
} from "./volume-model";
import type { VolumeMount } from "../types/container";

const vol = (p: Partial<VolumeMount>): VolumeMount => ({
  id: "vol_x",
  name: "",
  mountPath: "/data",
  readOnly: false,
  ...p,
});

test("the three kinds are labelled Volume, File and Bind", () => {
  assert.equal(VOLUME_KINDS.named.label, "Volume");
  assert.equal(VOLUME_KINDS.app.label, "File");
  assert.equal(VOLUME_KINDS.host.label, "Bind");
});

test("the stored discriminants are untouched by the renaming", () => {
  assert.deepEqual(VOLUME_KIND_ORDER, ["named", "app", "host"]);
  for (const kind of VOLUME_KIND_ORDER) {
    assert.equal(VOLUME_KINDS[kind].kind, kind);
  }
});

test("no kind's copy leaks the old jargon", () => {
  const text = Object.values(VOLUME_KINDS)
    .map(
      (k) =>
        `${k.label} ${k.summary} ${k.tooltip} ${k.sourceLabel} ${k.sourceTooltip}`,
    )
    .join(" ")
    .toLowerCase();
  for (const banned of [
    "named volume",
    "app file",
    "host path",
    "bind mount",
    "docker",
  ]) {
    assert.ok(!text.includes(banned), `copy still says "${banned}"`);
  }
});

test("no copy anywhere uses an ellipsis character", () => {
  const text = JSON.stringify(VOLUME_KINDS);
  assert.ok(!text.includes("…"), "ellipsis in kind copy");
});

test("only Bind is gated on a permission", () => {
  assert.equal(VOLUME_KINDS.host.needsPermission, true);
  assert.equal(VOLUME_KINDS.named.needsPermission, false);
  assert.equal(VOLUME_KINDS.app.needsPermission, false);
});

test("an absent discriminant reads as a Volume (back-compat rows)", () => {
  assert.equal(kindOf(vol({})), "named");
  assert.equal(metaOf(vol({})).label, "Volume");
  assert.equal(metaOf(vol({ type: "host" })).label, "Bind");
});

test("deriveVolumeName turns a path into a docker-safe name", () => {
  assert.equal(deriveVolumeName("/var/data"), "var-data");
  assert.equal(deriveVolumeName("/app/uploads/"), "app-uploads");
  assert.equal(deriveVolumeName("/"), "data");
  assert.equal(deriveVolumeName("/MiXeD/Case"), "mixed-case");
});

test("a row left without a path lands in the app's own folder, named after its source", () => {
  assert.equal(
    derivedMountPath(vol({ name: "uploads", mountPath: "" }), "/app"),
    "/app/uploads",
  );
  assert.equal(
    derivedMountPath(
      vol({ type: "app", projectPath: "config.toml", mountPath: "" }),
      "/app",
    ),
    "/app/config.toml",
  );
  assert.equal(
    derivedMountPath(
      vol({ type: "host", hostPath: "/srv/media", mountPath: "" }),
      "/app",
    ),
    "/app/media",
  );
});

test("a File keeps the layout it had in the repo", () => {
  assert.equal(
    derivedMountPath(
      vol({ type: "app", projectPath: "conf/app.toml" }),
      "/app",
    ),
    "/app/conf/app.toml",
  );
  assert.equal(
    derivedMountPath(
      vol({ type: "app", projectPath: "./conf/app.toml" }),
      "/app",
    ),
    "/app/conf/app.toml",
  );
  assert.equal(
    derivedMountPath(vol({ type: "host", hostPath: "/srv/media/" }), "/app"),
    "/app/media",
  );
});

test("the derived path keeps the name's case; only the volume's own name folds", () => {
  assert.equal(
    derivedMountPath(vol({ name: "Uploads", mountPath: "" }), "/app"),
    "/app/Uploads",
  );
  assert.equal(
    namedVolumeTarget(vol({ name: "Uploads", mountPath: "" }), "shop", "/app"),
    "deplo-shop-uploads",
  );
});

test("the derived path follows the app's root directory, like the workdir does", () => {
  assert.equal(
    derivedMountPath(
      vol({ name: "uploads" }),
      containerWorkdir("github", "apps/web"),
    ),
    "/app/apps/web/uploads",
  );
});

test("nothing is derived when Deplo does not know the working directory", () => {
  for (const workdir of [null, undefined, ""]) {
    assert.equal(
      derivedMountPath(vol({ name: "uploads", mountPath: "" }), workdir),
      "",
    );
  }
  assert.equal(
    derivedMountPath(
      vol({ name: "uploads" }),
      containerWorkdir("docker-image", null),
    ),
    "",
  );
});

test("nothing is derived from a source that is still empty", () => {
  assert.equal(derivedMountPath(vol({ name: "", mountPath: "" }), "/app"), "");
  assert.equal(
    derivedMountPath(vol({ type: "app", mountPath: "" }), "/app"),
    "",
  );
  assert.equal(
    derivedMountPath(vol({ type: "host", mountPath: "" }), "/app"),
    "",
  );
  assert.equal(
    derivedMountPath(
      vol({ type: "host", hostPath: "/", mountPath: "" }),
      "/app",
    ),
    "",
  );
});

test("what the user typed always wins over what Deplo would derive", () => {
  assert.equal(
    effectiveMountPath(
      vol({ name: "uploads", mountPath: "/var/lib/data" }),
      "/app",
    ),
    "/var/lib/data",
  );
  assert.equal(
    effectiveMountPath(vol({ name: "uploads", mountPath: "" }), "/app"),
    "/app/uploads",
  );
  assert.equal(
    effectiveMountPath(vol({ name: "u", mountPath: "/data/" }), "/app"),
    "/data",
  );
});

test("a clean row of each kind has no problem", () => {
  assert.equal(volumeProblem(vol({ name: "uploads" })), null);
  assert.equal(
    volumeProblem(vol({ type: "app", projectPath: "config.toml" })),
    null,
  );
  assert.equal(
    volumeProblem(vol({ type: "host", hostPath: "/srv/media" })),
    null,
  );
});

test("a blank name is fine - the server derives one", () => {
  assert.equal(volumeProblem(vol({ name: "" })), null);
});

test("the path inside the app must be absolute, clean and unreserved", () => {
  assert.equal(volumeProblem(vol({ mountPath: "" }))?.field, "mountPath");
  assert.match(
    volumeProblem(vol({ mountPath: "data" }))!.message,
    /start with a slash/,
  );
  assert.match(
    volumeProblem(vol({ mountPath: "/my data" }))!.message,
    /spaces/,
  );
  assert.match(
    volumeProblem(vol({ mountPath: "/data:ro" }))!.message,
    /spaces/,
  );
  assert.match(volumeProblem(vol({ mountPath: "/a/../b" }))!.message, /"\.\."/);
});

test("every reserved system path is refused, as itself and as a parent", () => {
  for (const p of RESERVED_MOUNT_PREFIXES) {
    assert.match(volumeProblem(vol({ mountPath: p }))!.message, /system/, p);
    assert.match(
      volumeProblem(vol({ mountPath: `${p}/inner` }))!.message,
      /system/,
      p,
    );
  }
  assert.equal(volumeProblem(vol({ mountPath: "/etcetera" })), null);
});

test("a File may sit inside a system directory, but never replace one", () => {
  const file = (mountPath: string) =>
    volumeProblem(vol({ type: "app", projectPath: "nginx.conf", mountPath }));
  assert.equal(file("/etc/nginx/nginx.conf"), null);
  assert.equal(file("/usr/share/nginx/html/index.html"), null);
  for (const p of RESERVED_MOUNT_PREFIXES) {
    assert.match(file(p)!.message, /system/, p);
  }
});

test("a Bind may sit inside a system directory, but never replace one", () => {
  const bind = (mountPath: string) =>
    volumeProblem(
      vol({ type: "host", hostPath: "/var/run/docker.sock", mountPath }),
    );
  assert.equal(bind("/var/run/docker.sock"), null);
  assert.equal(bind("/usr/share/nginx/html"), null);
  for (const p of RESERVED_MOUNT_PREFIXES) {
    assert.match(bind(p)!.message, /system/, p);
  }
});

test("a Bind wants an absolute server path", () => {
  assert.match(
    volumeProblem(vol({ type: "host" }))!.message,
    /path on the server/,
  );
  assert.match(
    volumeProblem(vol({ type: "host", hostPath: "srv/media" }))!.message,
    /start with a slash/,
  );
  assert.match(
    volumeProblem(vol({ type: "host", hostPath: "/srv/../etc" }))!.message,
    /"\.\."/,
  );
  assert.equal(
    volumeProblem(vol({ type: "host", hostPath: "/srv/x" }))?.field,
    undefined,
  );
});

test("a File wants a relative path inside this app's Files", () => {
  assert.match(
    volumeProblem(vol({ type: "app" }))!.message,
    /path in this app's Files/,
  );
  assert.match(
    volumeProblem(vol({ type: "app", projectPath: "/abs" }))!.message,
    /relative/,
  );
  assert.match(
    volumeProblem(vol({ type: "app", projectPath: "../escape" }))!.message,
    /"\.\."/,
  );
  assert.equal(
    volumeProblem(vol({ type: "app", projectPath: "./config.toml" })),
    null,
  );
});

test("a Volume name must be docker-shaped and short", () => {
  assert.match(volumeProblem(vol({ name: "Bad Name" }))!.message, /lowercase/);
  assert.match(volumeProblem(vol({ name: "_leading" }))!.message, /lowercase/);
  assert.match(
    volumeProblem(vol({ name: "a".repeat(41) }))!.message,
    /characters/,
  );
  assert.equal(volumeProblem(vol({ name: "Uploads" })), null);
});

test("the path inside the app is not required when Deplo can derive one", () => {
  assert.equal(
    volumeProblem(vol({ name: "uploads", mountPath: "" }), "/app"),
    null,
  );
  assert.equal(
    volumeProblem(
      vol({ type: "app", projectPath: "config.toml", mountPath: "" }),
      "/app",
    ),
    null,
  );
  assert.equal(
    volumeProblem(
      vol({ type: "host", hostPath: "/srv/media", mountPath: "" }),
      "/app",
    ),
    null,
  );
});

test("with no working directory to derive from, the path is still required", () => {
  const p = volumeProblem(vol({ name: "uploads", mountPath: "" }), null);
  assert.equal(p?.field, "mountPath");
  assert.match(p!.message, /path inside the app/);
});

test("a Volume with neither a name nor a path is asked for the shorter one", () => {
  assert.equal(
    volumeProblem(vol({ name: "", mountPath: "" }), "/app")?.field,
    "source",
  );
  assert.match(
    volumeProblem(vol({ name: "", mountPath: "" }), "/app")!.message,
    /name/,
  );
  assert.equal(
    volumeProblem(vol({ name: "", mountPath: "" }), null)?.field,
    "mountPath",
  );
});

test("a derived path is validated exactly like a typed one", () => {
  assert.match(
    volumeProblem(vol({ name: "uploads", mountPath: "" }), "/usr/local")!
      .message,
    /system/,
  );
});

test("the problem names the field to ring, not just the message", () => {
  assert.equal(volumeProblem(vol({ mountPath: "nope" }))!.field, "mountPath");
  assert.equal(
    volumeProblem(vol({ type: "host", hostPath: "nope" }))!.field,
    "source",
  );
  assert.equal(volumeProblem(vol({ name: "NO PE" }))!.field, "source");
});

test("two mounts at the same path in the same service collide", () => {
  assert.match(
    volumeSetProblem([
      vol({ id: "a", name: "x" }),
      vol({ id: "b", name: "y" }),
    ])!,
    /share the path \/data/,
  );
});

test("two services of a stack may each mount their own /data", () => {
  assert.equal(
    volumeSetProblem([
      vol({ id: "a", name: "x", service: "web" }),
      vol({ id: "b", name: "y", service: "db" }),
    ]),
    null,
  );
});

test("two volumes may not share a name, derived names included", () => {
  assert.match(
    volumeSetProblem([
      vol({ id: "a", name: "shared", mountPath: "/one" }),
      vol({ id: "b", name: "shared", mountPath: "/two" }),
    ])!,
    /share the name shared/,
  );
  assert.equal(
    volumeSetProblem([
      vol({ id: "a", mountPath: "/one" }),
      vol({ id: "b", mountPath: "/two" }),
    ]),
    null,
  );
  assert.match(
    volumeSetProblem([
      vol({ id: "a", name: "two", mountPath: "/one" }),
      vol({ id: "b", mountPath: "/two" }),
    ])!,
    /share the name two/,
  );
});

test("two rows that DERIVE the same path collide just as loudly", () => {
  assert.match(
    volumeSetProblem(
      [
        vol({ id: "a", name: "uploads", mountPath: "" }),
        vol({ id: "b", type: "app", projectPath: "uploads", mountPath: "" }),
      ],
      "/app",
    )!,
    /share the path \/app\/uploads/,
  );
});

test("binds and files are exempt from the name collision rule", () => {
  assert.equal(
    volumeSetProblem([
      vol({
        id: "a",
        type: "host",
        name: "same",
        hostPath: "/a",
        mountPath: "/one",
      }),
      vol({
        id: "b",
        type: "host",
        name: "same",
        hostPath: "/b",
        mountPath: "/two",
      }),
    ]),
    null,
  );
});

test("the readout says what will happen, per kind", () => {
  assert.match(
    volumeReadout(vol({ name: "uploads", mountPath: "/app/up" }), "shop"),
    /deplo-shop-uploads/,
  );
  assert.match(
    volumeReadout(
      vol({ type: "app", projectPath: "config.toml", mountPath: "/c" }),
      "shop",
    ),
    /config\.toml in this app's Files/,
  );
  assert.match(
    volumeReadout(
      vol({ type: "host", hostPath: "/srv/m", mountPath: "/m" }),
      "shop",
    ),
    /server's \/srv\/m/,
  );
});

test("the readout previews the DERIVED volume name when the name is blank", () => {
  assert.match(
    volumeReadout(vol({ name: "", mountPath: "/var/data" }), "shop"),
    /deplo-shop-var-data/,
  );
});

test("the readout says a propagated submount stays writable under :ro", () => {
  const both = volumeReadout(
    vol({
      type: "host",
      hostPath: "/srv/m",
      mountPath: "/m",
      readOnly: true,
      propagation: "rslave",
    }),
    "shop",
  );
  assert.match(both, /read it but not change it/);
  assert.match(both, /stays writable/);
  assert.doesNotMatch(
    volumeReadout(
      vol({
        type: "host",
        hostPath: "/srv/m",
        mountPath: "/m",
        propagation: "rslave",
      }),
      "shop",
    ),
    /stays writable/,
  );
  assert.doesNotMatch(
    volumeReadout(
      vol({
        type: "host",
        hostPath: "/srv/m",
        mountPath: "/m",
        readOnly: true,
      }),
      "shop",
    ),
    /stays writable/,
  );
});

test("read-only is stated in the readout, not left to the switch alone", () => {
  assert.match(
    volumeReadout(vol({ name: "x", mountPath: "/x", readOnly: true }), "shop"),
    /read it but not change it/,
  );
  assert.doesNotMatch(
    volumeReadout(vol({ name: "x", mountPath: "/x" }), "shop"),
    /read it but not change it/,
  );
});

test("the readout states the derived path, because that is what will happen", () => {
  assert.match(
    volumeReadout(vol({ name: "uploads", mountPath: "" }), "shop", "/app"),
    /Keeps \/app\/uploads on a disk Deplo manages/,
  );
  assert.match(
    volumeReadout(
      vol({ type: "host", hostPath: "/srv/media", mountPath: "" }),
      "shop",
      "/app",
    ),
    /Shares the server's \/srv\/media at \/app\/media/,
  );
});

test("a Volume named but not placed still shows its real on-host name", () => {
  assert.equal(
    namedVolumeTarget(vol({ name: "uploads", mountPath: "" }), "shop", "/app"),
    "deplo-shop-uploads",
  );
});

test("a half-filled row still gets an honest readout, never a broken sentence", () => {
  for (const v of [
    vol({ mountPath: "" }),
    vol({ type: "app", projectPath: "", mountPath: "" }),
    vol({ type: "host", hostPath: "", mountPath: "" }),
  ]) {
    const out = volumeReadout(v, "shop");
    assert.ok(out.length > 10 && out.endsWith("."), out);
    assert.ok(!out.includes("undefined"), out);
  }
});

test("switching kind PRESERVES each kind's own source", () => {
  const asBind = switchKind(vol({ name: "uploads", mountPath: "/up" }), "host");
  assert.equal(asBind.type, "host");
  assert.equal(asBind.name, "uploads");
  const back = switchKind(asBind, "named");
  assert.equal(back.type, "named");
  assert.equal(back.name, "uploads");
});

test("re-picking the current kind is not an edit", () => {
  const stored = vol({ name: "uploads" });
  assert.equal(switchKind(stored, "named"), stored);
  const explicit = vol({ type: "host", hostPath: "/srv/x" });
  assert.equal(switchKind(explicit, "host"), explicit);
});

test("switching kind keeps the path inside the app and the read-only flag", () => {
  const before = vol({
    name: "u",
    mountPath: "/data",
    readOnly: true,
    id: "keep",
  });
  const after = switchKind(before, "app");
  assert.equal(after.mountPath, "/data");
  assert.equal(after.readOnly, true);
  assert.equal(after.id, "keep");
});

test("containerWorkdir is /app for anything Deplo builds", () => {
  for (const source of ["github", "git", "upload"]) {
    assert.equal(containerWorkdir(source, ""), "/app");
    assert.equal(containerWorkdir(source, null), "/app");
    assert.equal(containerWorkdir(source, "."), "/app");
  }
});

test("containerWorkdir follows a root directory, exactly like the Dockerfile", () => {
  assert.equal(containerWorkdir("github", "apps/web"), "/app/apps/web");
  assert.equal(containerWorkdir("github", "./apps/web/"), "/app/apps/web");
});

test("containerWorkdir is null when the image chose its own", () => {
  assert.equal(containerWorkdir("docker-image", ""), null);
  assert.equal(containerWorkdir("compose", "whatever"), null);
});

test("every kind has a `Good for` recognition line, with no jargon", () => {
  for (const kind of VOLUME_KIND_ORDER) {
    const ex = VOLUME_KINDS[kind].examples;
    assert.ok(ex.length > 15, kind);
    assert.ok(!ex.includes("…"), kind);
    assert.ok(!/docker|volume mount|bind mount/i.test(ex), `${kind}: ${ex}`);
  }
});

test("namedVolumeTarget gives the real on-host name a Volume will use", () => {
  assert.equal(
    namedVolumeTarget(vol({ name: "uploads", mountPath: "/up" }), "shop"),
    "deplo-shop-uploads",
  );
  assert.equal(
    namedVolumeTarget(vol({ name: "", mountPath: "/var/data" }), "shop"),
    "deplo-shop-var-data",
  );
  assert.equal(
    namedVolumeTarget(vol({ name: "Uploads", mountPath: "/up" }), "shop"),
    "deplo-shop-uploads",
  );
});

test("namedVolumeTarget is null when there is nothing honest to show", () => {
  assert.equal(
    namedVolumeTarget(vol({ name: "", mountPath: "" }), "shop"),
    null,
  );
  assert.equal(
    namedVolumeTarget(vol({ type: "app", projectPath: "c.toml" }), "shop"),
    null,
  );
  assert.equal(
    namedVolumeTarget(vol({ type: "host", hostPath: "/srv/x" }), "shop"),
    null,
  );
});

test("only Volume declares a target row; the other kinds have none", () => {
  assert.equal(VOLUME_KINDS.named.targetLabel, "Stored on the server as");
  assert.equal(VOLUME_KINDS.app.targetLabel, null);
  assert.equal(VOLUME_KINDS.host.targetLabel, null);
});

test("each kind has a distinct chip tone, warning reserved for the gated one", () => {
  assert.equal(VOLUME_KINDS.host.chip, "warning");
  const tones = VOLUME_KIND_ORDER.map((k) => VOLUME_KINDS[k].chip);
  assert.equal(new Set(tones).size, tones.length);
});

test("a path in Files normalises to one form, whatever the user typed", () => {
  assert.equal(normalizeFilesPath("  config.toml "), "config.toml");
  assert.equal(normalizeFilesPath("./conf/app.toml"), "conf/app.toml");
  assert.equal(normalizeFilesPath("conf/"), "conf");
  assert.equal(normalizeFilesPath(""), "");
  assert.equal(normalizeFilesPath(undefined), "");
  assert.equal(
    normalizeFilesPath("./config.toml"),
    normalizeFilesPath("config.toml"),
  );
});

test("the path in Files is offered from the mount path's file name", () => {
  assert.equal(filesPathFromMountPath("/etc/nginx/nginx.conf"), "nginx.conf");
  assert.equal(filesPathFromMountPath("/app/config.toml"), "config.toml");
  assert.equal(filesPathFromMountPath("/app/conf/"), "conf");
  assert.equal(filesPathFromMountPath("/"), "");
  assert.equal(filesPathFromMountPath(""), "");
  assert.equal(filesPathFromMountPath("/app/.."), "");
});
