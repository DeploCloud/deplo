import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RESERVED_MOUNT_PREFIXES,
  containerWorkdir,
  switchKind,
  VOLUME_KINDS,
  VOLUME_KIND_ORDER,
  deriveVolumeName,
  kindOf,
  metaOf,
  namedVolumeTarget,
  volumeProblem,
  volumeReadout,
  volumeSetProblem,
} from "./volume-model";
import type { VolumeMount } from "../types";

/**
 * The Storage editor's model. Two properties matter beyond the plain unit checks:
 *
 *  - the UI labels are Volume / File / Bind while the STORED discriminants stay
 *    "named" / "app" / "host" (renaming them would be a migration for a caption);
 *  - `volumeProblem` must not accept anything the server's `validateVolumes`
 *    rejects — they share this module's constants, and these tests pin the
 *    overlap case by case.
 */

const vol = (p: Partial<VolumeMount>): VolumeMount => ({
  id: "vol_x",
  name: "",
  mountPath: "/data",
  readOnly: false,
  ...p,
});

/* ---- kind naming --------------------------------------------------- */

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
    .map((k) => `${k.label} ${k.summary} ${k.tooltip} ${k.sourceLabel} ${k.sourceTooltip}`)
    .join(" ")
    .toLowerCase();
  for (const banned of ["named volume", "app file", "host path", "bind mount", "docker"]) {
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

/* ---- derived name -------------------------------------------------- */

test("deriveVolumeName turns a path into a docker-safe name", () => {
  assert.equal(deriveVolumeName("/var/data"), "var-data");
  assert.equal(deriveVolumeName("/app/uploads/"), "app-uploads");
  assert.equal(deriveVolumeName("/"), "data");
  assert.equal(deriveVolumeName("/MiXeD/Case"), "mixed-case");
});

/* ---- per-row validation -------------------------------------------- */

test("a clean row of each kind has no problem", () => {
  assert.equal(volumeProblem(vol({ name: "uploads" })), null);
  assert.equal(volumeProblem(vol({ type: "app", projectPath: "config.toml" })), null);
  assert.equal(volumeProblem(vol({ type: "host", hostPath: "/srv/media" })), null);
});

test("a blank name is fine — the server derives one", () => {
  assert.equal(volumeProblem(vol({ name: "" })), null);
});

test("the path inside the app must be absolute, clean and unreserved", () => {
  assert.equal(volumeProblem(vol({ mountPath: "" }))?.field, "mountPath");
  assert.match(volumeProblem(vol({ mountPath: "data" }))!.message, /start with a slash/);
  assert.match(volumeProblem(vol({ mountPath: "/my data" }))!.message, /spaces/);
  assert.match(volumeProblem(vol({ mountPath: "/data:ro" }))!.message, /spaces/);
  assert.match(volumeProblem(vol({ mountPath: "/a/../b" }))!.message, /"\.\."/);
});

test("every reserved system path is refused, as itself and as a parent", () => {
  for (const p of RESERVED_MOUNT_PREFIXES) {
    assert.match(volumeProblem(vol({ mountPath: p }))!.message, /system/, p);
    assert.match(volumeProblem(vol({ mountPath: `${p}/inner` }))!.message, /system/, p);
  }
  // A path that merely starts with the same letters is NOT reserved.
  assert.equal(volumeProblem(vol({ mountPath: "/etcetera" })), null);
});

test("a Bind wants an absolute server path", () => {
  assert.match(volumeProblem(vol({ type: "host" }))!.message, /path on the server/);
  assert.match(
    volumeProblem(vol({ type: "host", hostPath: "srv/media" }))!.message,
    /start with a slash/,
  );
  assert.match(
    volumeProblem(vol({ type: "host", hostPath: "/srv/../etc" }))!.message,
    /"\.\."/,
  );
  assert.equal(volumeProblem(vol({ type: "host", hostPath: "/srv/x" }))?.field, undefined);
});

test("a File wants a relative path inside this app's Files", () => {
  assert.match(volumeProblem(vol({ type: "app" }))!.message, /path in this app's Files/);
  assert.match(
    volumeProblem(vol({ type: "app", projectPath: "/abs" }))!.message,
    /relative/,
  );
  assert.match(
    volumeProblem(vol({ type: "app", projectPath: "../escape" }))!.message,
    /"\.\."/,
  );
  // The `./` marker the compose convention uses is accepted and stripped.
  assert.equal(volumeProblem(vol({ type: "app", projectPath: "./config.toml" })), null);
});

test("a Volume name must be docker-shaped and short", () => {
  assert.match(volumeProblem(vol({ name: "Bad Name" }))!.message, /lowercase/);
  assert.match(volumeProblem(vol({ name: "_leading" }))!.message, /lowercase/);
  assert.match(volumeProblem(vol({ name: "a".repeat(41) }))!.message, /characters/);
  // Case is folded before the check, so a capitalised name is accepted.
  assert.equal(volumeProblem(vol({ name: "Uploads" })), null);
});

test("the problem names the field to ring, not just the message", () => {
  assert.equal(volumeProblem(vol({ mountPath: "nope" }))!.field, "mountPath");
  assert.equal(volumeProblem(vol({ type: "host", hostPath: "nope" }))!.field, "source");
  assert.equal(volumeProblem(vol({ name: "NO PE" }))!.field, "source");
});

/* ---- set-level validation ------------------------------------------ */

test("two mounts at the same path in the same service collide", () => {
  assert.match(
    volumeSetProblem([vol({ id: "a", name: "x" }), vol({ id: "b", name: "y" })])!,
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
  // Both blank ⇒ both derive from their paths, so these do NOT collide.
  assert.equal(
    volumeSetProblem([
      vol({ id: "a", mountPath: "/one" }),
      vol({ id: "b", mountPath: "/two" }),
    ]),
    null,
  );
  // A typed name colliding with a DERIVED one still collides.
  assert.match(
    volumeSetProblem([
      vol({ id: "a", name: "two", mountPath: "/one" }),
      vol({ id: "b", mountPath: "/two" }),
    ])!,
    /share the name two/,
  );
});

test("binds and files are exempt from the name collision rule", () => {
  // Neither has a docker volume name, so identical names are harmless.
  assert.equal(
    volumeSetProblem([
      vol({ id: "a", type: "host", name: "same", hostPath: "/a", mountPath: "/one" }),
      vol({ id: "b", type: "host", name: "same", hostPath: "/b", mountPath: "/two" }),
    ]),
    null,
  );
});

/* ---- readout ------------------------------------------------------- */

test("the readout says what will happen, per kind", () => {
  assert.match(
    volumeReadout(vol({ name: "uploads", mountPath: "/app/up" }), "shop"),
    /deplo-shop-uploads/,
  );
  assert.match(
    volumeReadout(vol({ type: "app", projectPath: "config.toml", mountPath: "/c" }), "shop"),
    /from this app's Files/,
  );
  assert.match(
    volumeReadout(vol({ type: "host", hostPath: "/srv/m", mountPath: "/m" }), "shop"),
    /server's \/srv\/m/,
  );
});

test("the readout previews the DERIVED volume name when the name is blank", () => {
  assert.match(
    volumeReadout(vol({ name: "", mountPath: "/var/data" }), "shop"),
    /deplo-shop-var-data/,
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

/* ---- switching kind ------------------------------------------------- */

test("switching kind PRESERVES each kind's own source", () => {
  // Preserving is what makes a mis-click one click to undo. It is safe because
  // only the selected kind's field renders, and both the save payload and the
  // dirty key are type-gated (see storage-settings-form) — so a name typed for a
  // Volume can never ship on a Bind row.
  const asBind = switchKind(vol({ name: "uploads", mountPath: "/up" }), "host");
  assert.equal(asBind.type, "host");
  assert.equal(asBind.name, "uploads");
  const back = switchKind(asBind, "named");
  assert.equal(back.type, "named");
  assert.equal(back.name, "uploads");
});

test("re-picking the current kind is not an edit", () => {
  // A stored Volume row comes back with `type` ABSENT. Writing "named" over it
  // would arm the unsaved-changes guard with nothing changed, so the switch must
  // return the very same object.
  const stored = vol({ name: "uploads" });
  assert.equal(switchKind(stored, "named"), stored);
  const explicit = vol({ type: "host", hostPath: "/srv/x" });
  assert.equal(switchKind(explicit, "host"), explicit);
});

test("switching kind keeps the path inside the app and the read-only flag", () => {
  const before = vol({ name: "u", mountPath: "/data", readOnly: true, id: "keep" });
  const after = switchKind(before, "app");
  // Those two answers mean the same thing for every kind.
  assert.equal(after.mountPath, "/data");
  assert.equal(after.readOnly, true);
  assert.equal(after.id, "keep");
});

/* ---- container workdir hint ---------------------------------------- */

test("containerWorkdir is /app for anything deplo builds", () => {
  for (const source of ["github", "git", "upload"]) {
    assert.equal(containerWorkdir(source, ""), "/app");
    assert.equal(containerWorkdir(source, null), "/app");
    assert.equal(containerWorkdir(source, "."), "/app");
  }
});

test("containerWorkdir follows a root directory, exactly like the Dockerfile", () => {
  // Mirrors lib/deploy/dockerfile.ts: WORKDIR /app/<root>.
  assert.equal(containerWorkdir("github", "apps/web"), "/app/apps/web");
  assert.equal(containerWorkdir("github", "./apps/web/"), "/app/apps/web");
});

test("containerWorkdir is null when the image chose its own", () => {
  // A prebuilt image or a compose stack: deplo has no idea, so it must not guess.
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

/* ---- the copyable on-host target (Volume only) ---------------------- */

test("namedVolumeTarget gives the real on-host name a Volume will use", () => {
  assert.equal(
    namedVolumeTarget(vol({ name: "uploads", mountPath: "/up" }), "shop"),
    "deplo-shop-uploads",
  );
  // Blank name ⇒ the name the SERVER will derive, not a placeholder.
  assert.equal(
    namedVolumeTarget(vol({ name: "", mountPath: "/var/data" }), "shop"),
    "deplo-shop-var-data",
  );
  // Case-folded like the writer does.
  assert.equal(
    namedVolumeTarget(vol({ name: "Uploads", mountPath: "/up" }), "shop"),
    "deplo-shop-uploads",
  );
});

test("namedVolumeTarget is null when there is nothing honest to show", () => {
  // Nothing to derive from yet.
  assert.equal(namedVolumeTarget(vol({ name: "", mountPath: "" }), "shop"), null);
  // A File's real source is <stacks>/files/<slug>, which the client cannot know,
  // and a Bind's target is the path the user just typed. Neither gets a line.
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
