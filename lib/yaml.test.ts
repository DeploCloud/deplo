import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "./yaml";

test("an explicitly tagged merge key parses like a bare one", () => {
  const doc = yaml.load(`x-common: &common
  restart: unless-stopped
x-ch: &ch
  !!merge <<: *common
  image: clickhouse
services:
  ch:
    <<: *ch
`) as { services: { ch: Record<string, string> } };
  assert.deepEqual(doc.services.ch, {
    restart: "unless-stopped",
    image: "clickhouse",
  });
});

test("broken YAML still throws with its position", () => {
  assert.throws(() => yaml.load("a:\n\tb: 1\n"), /tab/i);
});
