import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeHasHostBindMount,
  isEscapingSource,
  isFilesConventionSource,
  isHostBindSource,
  volumeSource,
} from "./volumes";

test("volumeSource extracts the source of each volume entry form", () => {
  assert.equal(volumeSource("/data:/data"), "/data");
  assert.equal(volumeSource("named:/data"), "named");
  assert.equal(volumeSource("/anon"), null);
  assert.equal(
    volumeSource({ type: "bind", source: "/host", target: "/x" }),
    "/host",
  );
});

test("isHostBindSource: absolute and escaping sources are host binds", () => {
  assert.equal(isHostBindSource("/data"), true);
  assert.equal(isHostBindSource("/etc/passwd"), true);
  assert.equal(isHostBindSource("./config"), false);
  assert.equal(isHostBindSource("./folder/x"), false);
  assert.equal(isHostBindSource("."), false);
  assert.equal(isHostBindSource("../files/config"), true);
  assert.equal(isHostBindSource("../sibling/data"), true);
  assert.equal(isHostBindSource("./../escape"), true);
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

test("composeHasHostBindMount: false for the ./ app-files convention", () => {
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
