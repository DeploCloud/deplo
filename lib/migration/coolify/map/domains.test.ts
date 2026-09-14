import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCoolifyFqdns } from "./domains";

test("parseCoolifyFqdns reads the list, its ports and its paths", () => {
  const { value: d, notes } = parseCoolifyFqdns(
    "https://app.acme.com,https://api.acme.com:3000,http://old.acme.com/v1/",
  );
  assert.deepEqual(
    d.map((x) => [x.host, x.port, x.path, x.https, x.certificateType]),
    [
      ["app.acme.com", null, null, true, "letsencrypt"],
      ["api.acme.com", 3000, null, true, "letsencrypt"],
      ["old.acme.com", null, "/v1", false, "none"],
    ],
  );
  // Deplo strips no prefix of its own, because Coolify adds no middleware to undo.
  assert.equal(d[2].stripPath, false);
  // Every one of them SAID which scheme it was, so there is nothing to warn about.
  assert.deepEqual(notes, []);
});

test("an address that names no scheme is not promoted to https", () => {
  // Four one-click services arrived on letsencrypt this way, off :80, and every http link anyone had written answered 404.
  const { value: d, notes } = parseCoolifyFqdns("uptimekuma6.acme.com");
  assert.deepEqual(
    d.map((x) => [x.host, x.https, x.certificateType]),
    [["uptimekuma6.acme.com", false, "none"]],
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /without http:\/\/ or https:\/\//);
});

test("parseCoolifyFqdns survives a bare host and refuses nonsense", () => {
  const { value: d } = parseCoolifyFqdns("app.acme.com, , not a url ,,");
  assert.deepEqual(
    d.map((x) => x.host),
    ["app.acme.com"],
  );
});

test("parseCoolifyFqdns keeps a compose stack's per-service domains apart", () => {
  const { value: d } = parseCoolifyFqdns(
    null,
    JSON.stringify({
      app: { domain: "https://app.acme.com:3000" },
      api: { domain: "https://api.acme.com" },
    }),
  );
  assert.deepEqual(
    d.map((x) => [x.serviceName, x.host, x.port, x.domainType]),
    [
      ["app", "app.acme.com", 3000, "compose"],
      ["api", "api.acme.com", null, "compose"],
    ],
  );
});

test("parseCoolifyFqdns names the same host once", () => {
  assert.equal(
    parseCoolifyFqdns("https://a.com,https://a.com,http://a.com").value.length,
    1,
  );
});

test("two variables for one host are merged, whichever order they arrive in", () => {
  // Coolify keeps SERVICE_FQDN_X and SERVICE_FQDN_X_<PORT> for the same address; taking the first left linkding's domain portless and Traefik answered 502.
  const withPort = { url: "linkding.acme.com:9090", service: null, port: 9090 };
  const without = { url: "linkding.acme.com", service: null, port: null };

  for (const order of [
    [without, withPort],
    [withPort, without],
  ]) {
    const { value } = parseCoolifyFqdns(null, null, order);
    assert.deepEqual(
      value.map((d) => [d.host, d.port]),
      [["linkding.acme.com", 9090]],
      `order ${order === undefined ? "" : JSON.stringify(order.map((o) => o.url))}`,
    );
  }
});

test("a scheme on either spelling is believed for the merged host", () => {
  const bare = { url: "app.acme.com", service: null, port: null };
  const secure = {
    url: "https://app.acme.com:8443",
    service: null,
    port: 8443,
  };

  for (const order of [
    [bare, secure],
    [secure, bare],
  ]) {
    const { value, notes } = parseCoolifyFqdns(null, null, order);
    assert.deepEqual(
      value.map((d) => [d.host, d.port, d.https, d.certificateType]),
      [["app.acme.com", 8443, true, "letsencrypt"]],
    );
    // One of them DID say https, so there is nothing to warn about.
    assert.deepEqual(notes, []);
  }
});
