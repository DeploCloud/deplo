import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeHasHostBindMount,
  composeMountsForeignStorage,
} from "./volumes";

test("composeMountsForeignStorage: an external volume is foreign", () => {
  for (const decl of [
    "    external: true",
    "    external: true\n    name: deplo_deplo-postgres",
    "    external:\n      name: deplo-victim-data",
    "    name: deplo-victim-data",
  ]) {
    const yaml = `services:\n  app:\n    image: nginx\n    volumes:\n      - stolen:/x\nvolumes:\n  stolen:\n${decl}`;
    assert.equal(
      composeMountsForeignStorage(yaml),
      true,
      `not caught:\n${decl}`,
    );
  }
});

test("composeMountsForeignStorage: a driver_opts bind of the host is foreign", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - hostroot:/host
volumes:
  hostroot:
    driver: local
    driver_opts:
      type: none
      device: /
      o: bind`;
  assert.equal(composeMountsForeignStorage(yaml), true);
  assert.equal(composeHasHostBindMount(yaml), false);
});

test("composeMountsForeignStorage: an ordinary app volume is not foreign", () => {
  const yaml = `services:
  app:
    image: postgres:16
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data: {}`;
  assert.equal(composeMountsForeignStorage(yaml), false);
});

test("composeMountsForeignStorage: no volumes block, and unparseable YAML", () => {
  assert.equal(
    composeMountsForeignStorage("services:\n  app:\n    image: nginx"),
    false,
  );
  assert.equal(composeMountsForeignStorage("volumes: [oops"), false);
  assert.equal(composeMountsForeignStorage(""), false);
});

test("composeMountsForeignStorage: a top-level secrets/configs file: source is a host-file read", () => {
  assert.equal(
    composeMountsForeignStorage(
      `services:\n  a:\n    image: x\n    secrets: [s]\nsecrets:\n  s:\n    file: /root/projects/deplo/.env`,
    ),
    true,
  );
  assert.equal(
    composeMountsForeignStorage(
      `services:\n  a:\n    image: x\nconfigs:\n  c:\n    file: ../victim/.env`,
    ),
    true,
  );
  for (const f of ["./db_pw.txt", "db_pw.txt", "conf/app.yml"])
    assert.equal(
      composeMountsForeignStorage(
        `services:\n  a:\n    image: x\nsecrets:\n  s:\n    file: ${f}`,
      ),
      false,
      f,
    );
  assert.equal(
    composeMountsForeignStorage(
      `services:\n  a:\n    image: x\nsecrets:\n  s:\n    environment: FOO`,
    ),
    false,
  );
});
