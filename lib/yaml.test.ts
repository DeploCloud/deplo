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

test("the same bytes inside a STRING are the author's, not syntax", () => {
  const doc = yaml.load(`services:
  web:
    command: "echo !!merge <<: hello"
    environment:
      NOTE: |
        !!merge <<: *common
      TIP: "!!merge <<: *x"
`) as {
    services: { web: { command: string; environment: Record<string, string> } };
  };
  const web = doc.services.web;
  assert.equal(web.command, "echo !!merge <<: hello");
  assert.equal(web.environment.NOTE, "!!merge <<: *common\n");
  assert.equal(web.environment.TIP, "!!merge <<: *x");
});

test("a bare date stays the text somebody typed", () => {
  const doc = yaml.load(`environment:
  WHEN: 2026-01-01
  STAMP: 2026-01-01T10:00:00Z
`) as { environment: Record<string, unknown> };
  assert.equal(doc.environment.WHEN, "2026-01-01");
  assert.equal(doc.environment.STAMP, "2026-01-01T10:00:00Z");
});

test("broken YAML throws with the position the lint reads", () => {
  try {
    yaml.load("a:\n\tb: 1\n");
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /tab/i);
    // 0-based, the shape every caller already reads off a load error.
    assert.deepEqual((e as { mark?: unknown }).mark, { line: 1, column: 0 });
    assert.equal(
      / at line \d+, column \d+:/.test((e as Error).message),
      false,
      "the position is the mark, not a tail on the message",
    );
  }
});

test("a document keeps its anchors, merges and comments", () => {
  const src = `# a stack
x-common: &common
  restart: unless-stopped # keep me
services:
  a:
    !!merge <<: *common
    image: nginx
`;
  assert.equal(String(yaml.parseDocument(src)), src);
});
