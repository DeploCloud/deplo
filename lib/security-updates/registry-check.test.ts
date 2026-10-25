import { test } from "node:test";
import assert from "node:assert/strict";

import { newerTagOf, repoDigestFor } from "./registry-check";

test("newerTagOf: the highest tag on the same line", () => {
  const tags = [
    "1.27-alpine",
    "1.29-alpine",
    "1.28-alpine",
    "2.0-alpine",
    "1.29",
    "latest",
  ];
  assert.equal(newerTagOf("1.27-alpine", tags), "1.29-alpine");
  assert.equal(newerTagOf("1.29-alpine", tags), null);
  assert.equal(
    newerTagOf("1.45.0", ["1.123.55", "1.46.0", "2.20.0", "1.123"]),
    "1.123.55",
  );
  assert.equal(newerTagOf("16-alpine", ["16-alpine", "17-alpine"]), null);
  assert.equal(newerTagOf("latest", tags), null);
  assert.equal(newerTagOf("v1.2", ["v1.10", "v1.9"]), "v1.10");
});

test("repoDigestFor: the digest of the repository the ref names", () => {
  const id = "sha256:" + "a".repeat(64);
  assert.equal(repoDigestFor("nginx:1.27-alpine", [`nginx@${id}`]), id);
  assert.equal(
    repoDigestFor("nginx:1.27-alpine", [`docker.io/library/nginx@${id}`]),
    id,
  );
  assert.equal(repoDigestFor("ghcr.io/acme/web:1", [`nginx@${id}`]), "");
  assert.equal(repoDigestFor("nginx", []), "");
});
