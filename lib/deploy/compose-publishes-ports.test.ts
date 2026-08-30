// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import { composePublishesPorts } from "./compose-lint";

/**
 * The server gates compose stacks that publish ports behind the `canExposePorts`
 * grant. "Publishing a port" means one thing: a service declares host-mapped
 * `ports:`.
 */

test("composePublishesPorts: true for a short-form host port", () => {
  const yaml = `services:
  app:
    image: nginx
    ports:
      - 8080:80`;
  assert.equal(composePublishesPorts(yaml), true);
});

test("composePublishesPorts: true for a bare published port number", () => {
  const yaml = `services:
  garage:
    image: dxflrs/garage
    ports:
      - 3900
      - 3901`;
  assert.equal(composePublishesPorts(yaml), true);
});

test("composePublishesPorts: true for a long-form port mapping", () => {
  const yaml = `services:
  app:
    image: nginx
    ports:
      - target: 80
        published: 8080
        protocol: tcp`;
  assert.equal(composePublishesPorts(yaml), true);
});

// `expose:` binds nothing on the host, so it must not cost the grant.
test("composePublishesPorts: false for an `expose:`-only stack", () => {
  const yaml = `services:
  app:
    image: nginx
    expose:
      - 3901`;
  assert.equal(composePublishesPorts(yaml), false);
});

// The real shape it used to be confused with: same stack, a `ports:` entry.
test("composePublishesPorts: true when the same stack also binds a host port", () => {
  const yaml = `services:
  app:
    image: nginx
    expose:
      - 3901
    ports:
      - 8080:3901`;
  assert.equal(composePublishesPorts(yaml), true);
});

test("composePublishesPorts: false when no service declares ports", () => {
  const yaml = `services:
  garage:
    image: dxflrs/garage
    restart: unless-stopped
  garage-webui:
    image: khairul169/garage-webui
volumes:
  garage-storage: {}`;
  assert.equal(composePublishesPorts(yaml), false);
});

test("composePublishesPorts: an empty ports: list publishes nothing", () => {
  const yaml = `services:
  app:
    image: nginx
    ports: []
    expose:`;
  assert.equal(composePublishesPorts(yaml), false);
});

test("composePublishesPorts: detects ports in any of several services", () => {
  const yaml = `services:
  web:
    image: nginx
  db:
    image: postgres
    ports:
      - 5432:5432`;
  assert.equal(composePublishesPorts(yaml), true);
});

test("composePublishesPorts: tolerant of malformed / empty input", () => {
  assert.equal(composePublishesPorts(""), false);
  assert.equal(composePublishesPorts("::: not yaml ["), false);
  assert.equal(composePublishesPorts("services: {}"), false);
});
