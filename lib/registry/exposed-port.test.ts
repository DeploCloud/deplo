import { test } from "node:test";
import assert from "node:assert/strict";

import { singleExposedPort } from "./client";

/**
 * A Docker-image app has no repository to read, so the image's own EXPOSE is the
 * only honest default. One port is an answer; none or several is not, and the
 * app keeps the default the Port field can correct.
 */

test("one tcp port is the answer", () => {
  assert.equal(singleExposedPort({ "80/tcp": {} }), 80);
  assert.equal(singleExposedPort({ "5432/tcp": {} }), 5432);
  // A bare key with no protocol is tcp, which is how some images write it.
  assert.equal(singleExposedPort({ "8080": {} }), 8080);
});

test("udp alongside one tcp port does not confuse it", () => {
  assert.equal(singleExposedPort({ "53/tcp": {}, "53/udp": {} }), 53);
});

test("several ports, none, or nonsense answer nothing", () => {
  assert.equal(singleExposedPort({ "80/tcp": {}, "443/tcp": {} }), null);
  assert.equal(singleExposedPort({}), null);
  assert.equal(singleExposedPort(undefined), null);
  assert.equal(singleExposedPort(null), null);
  assert.equal(singleExposedPort({ "0/tcp": {} }), null);
  assert.equal(singleExposedPort({ "70000/tcp": {} }), null);
  assert.equal(singleExposedPort({ "http/tcp": {} }), null);
});
