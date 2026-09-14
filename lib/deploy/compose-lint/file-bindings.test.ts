import { test } from "node:test";
import assert from "node:assert/strict";

import { composeFileBindings } from "./volumes";

test("composeFileBindings reads both volume spellings, with the service", () => {
  const yaml = [
    "services:",
    "  web:",
    "    volumes:",
    "      - ./nginx.conf:/etc/nginx/nginx.conf:ro",
    "      - data:/var/lib/data",
    "      - /srv/host:/mnt",
    "  api:",
    "    volumes:",
    "      - type: bind",
    "        source: ./conf.d/api.ini",
    "        target: /etc/api.ini",
  ].join("\n");
  assert.deepEqual(composeFileBindings(yaml), [
    {
      filePath: "nginx.conf",
      service: "web",
      mountPath: "/etc/nginx/nginx.conf",
      readOnly: true,
    },
    {
      filePath: "conf.d/api.ini",
      service: "api",
      mountPath: "/etc/api.ini",
      readOnly: false,
    },
  ]);
});

test("composeFileBindings ignores what it cannot show as one file", () => {
  const yaml = [
    "services:",
    "  web:",
    "    volumes:",
    "      - ./:/app",
    "      - ../outside.conf:/etc/x.conf",
    "      - ./no-target",
  ].join("\n");
  assert.deepEqual(composeFileBindings(yaml), []);
  assert.deepEqual(composeFileBindings("services: [oops"), []);
});
