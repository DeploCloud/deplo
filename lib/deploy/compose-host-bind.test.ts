import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeHasHostBindMount,
  isEscapingSource,
  isFilesConventionSource,
  isHostBindSource,
  volumeSource,
} from "./compose-lint";

/**
 * The server gates compose edits that bind-mount a host path behind the
 * `canMountHostVolumes` grant. The detection MUST agree with the editor lint
 * (both use volumeSource + isHostBindSource), so it's tested directly here.
 *
 * A host bind is a source that escapes the project sandbox — an ABSOLUTE path,
 * OR a `..`-climbing path — and is NOT the service-files `./<x>` convention
 * (rewritten to the project-isolated dir at deploy time). Named/anonymous
 * volumes and `./`-relative mounts are not host binds.
 */

test("volumeSource extracts the source of each volume entry form", () => {
  assert.equal(volumeSource("/data:/data"), "/data");
  assert.equal(volumeSource("named:/data"), "named");
  assert.equal(volumeSource("/anon"), null); // no ":" → anonymous, not a bind src
  assert.equal(volumeSource({ type: "bind", source: "/host", target: "/x" }), "/host");
});

test("isHostBindSource: absolute and escaping sources are host binds", () => {
  assert.equal(isHostBindSource("/data"), true);
  assert.equal(isHostBindSource("/etc/passwd"), true);
  // The ./ service-files convention is project-isolated, not a host bind.
  assert.equal(isHostBindSource("./config"), false);
  assert.equal(isHostBindSource("./folder/x"), false);
  assert.equal(isHostBindSource("."), false);
  // A `..` climb escapes the sandbox — now treated as a host bind (gated).
  assert.equal(isHostBindSource("../files/config"), true);
  assert.equal(isHostBindSource("../sibling/data"), true);
  assert.equal(isHostBindSource("./../escape"), true);
  // Named volumes and anonymous mounts are not host binds.
  assert.equal(isHostBindSource("named"), false);
  assert.equal(isHostBindSource(null), false);
});

test("isFilesConventionSource: ./ paths in, .. and absolute out", () => {
  assert.equal(isFilesConventionSource("./config.toml"), true);
  assert.equal(isFilesConventionSource("./folder/x"), true);
  assert.equal(isFilesConventionSource("."), true);
  assert.equal(isFilesConventionSource("./"), true);
  assert.equal(isFilesConventionSource("../escape"), false);
  assert.equal(isFilesConventionSource("./../escape"), false);
  assert.equal(isFilesConventionSource("/abs"), false);
  assert.equal(isFilesConventionSource("named"), false);
});

test("isEscapingSource: any .. path segment escapes", () => {
  assert.equal(isEscapingSource("../x"), true);
  assert.equal(isEscapingSource("./../x"), true);
  assert.equal(isEscapingSource("a/../b"), true);
  assert.equal(isEscapingSource("./x"), false);
  assert.equal(isEscapingSource("/abs"), false);
  assert.equal(isEscapingSource("name"), false);
  assert.equal(isEscapingSource(null), false);
});

test("composeHasHostBindMount: true for an absolute string bind", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - /srv/data:/data`;
  assert.equal(composeHasHostBindMount(yaml), true);
});

test("composeHasHostBindMount: true for a long-form bind mount", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - type: bind
        source: /srv/data
        target: /data`;
  assert.equal(composeHasHostBindMount(yaml), true);
});

test("composeHasHostBindMount: false for a named volume", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - appdata:/data
volumes:
  appdata:`;
  assert.equal(composeHasHostBindMount(yaml), false);
});

test("composeHasHostBindMount: false for the ./ service-files convention", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - ./config:/etc/app/config`;
  assert.equal(composeHasHostBindMount(yaml), false);
});

test("composeHasHostBindMount: true for a .. sandbox escape (now gated)", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - ../sibling/data:/data`;
  assert.equal(composeHasHostBindMount(yaml), true);
});

test("composeHasHostBindMount: tolerant of malformed / empty input", () => {
  assert.equal(composeHasHostBindMount(""), false);
  assert.equal(composeHasHostBindMount("::: not yaml ["), false);
  assert.equal(composeHasHostBindMount("services: {}"), false);
});

test("composeHasHostBindMount: detects a bind in any of several services", () => {
  const yaml = `services:
  web:
    image: nginx
    volumes:
      - webdata:/data
  db:
    image: postgres
    volumes:
      - /var/lib/host-pg:/var/lib/postgresql/data`;
  assert.equal(composeHasHostBindMount(yaml), true);
});
