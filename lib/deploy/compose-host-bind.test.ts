import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeHasHostBindMount,
  isHostBindSource,
  volumeSource,
} from "./compose-lint";

/**
 * The server gates compose edits that bind-mount a host path behind the
 * `canMountHostVolumes` grant. The detection MUST agree with the editor lint
 * (both use volumeSource + isHostBindSource), so it's tested directly here.
 *
 * A host bind is an ABSOLUTE source that is NOT the `../files/...` convention
 * (rewritten to the project-isolated dir at deploy time). Named/anonymous
 * volumes and relative `../files` mounts are not host binds.
 */

test("volumeSource extracts the source of each volume entry form", () => {
  assert.equal(volumeSource("/data:/data"), "/data");
  assert.equal(volumeSource("named:/data"), "named");
  assert.equal(volumeSource("/anon"), null); // no ":" → anonymous, not a bind src
  assert.equal(volumeSource({ type: "bind", source: "/host", target: "/x" }), "/host");
});

test("isHostBindSource: absolute, non-files sources are host binds", () => {
  assert.equal(isHostBindSource("/data"), true);
  assert.equal(isHostBindSource("/etc/passwd"), true);
  // The ../files convention is project-isolated, not a host bind.
  assert.equal(isHostBindSource("../files/config"), false);
  assert.equal(isHostBindSource("files/config"), false);
  // Named volumes and anonymous mounts are not host binds.
  assert.equal(isHostBindSource("named"), false);
  assert.equal(isHostBindSource(null), false);
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

test("composeHasHostBindMount: false for the ../files convention", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - ../files/config:/etc/app/config`;
  assert.equal(composeHasHostBindMount(yaml), false);
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
