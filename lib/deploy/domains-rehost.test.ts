import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rehostSslip,
  rehostEmbeddedSslip,
  rehostBlueprintHosts,
  sslipEmbeddedIp,
} from "./domains";

/**
 * A template's generated sslip.io hosts are baked against the MASTER's IP in the
 * /new page (the target server isn't known until submit). createProject /
 * updateProjectSource re-host them onto the target server's IP using these three
 * helpers. The garage-with-ui case is the regression that motivated this: its
 * primary host + a `web-ui.` subdomain + (potentially) an env value all carry the
 * master IP and must move to the remote server's IP together.
 */

const MASTER = "95.135.208.208";
const REMOTE = "152.89.254.133";

test("sslipEmbeddedIp extracts the embedded IPv4 (and only an anchored sslip host)", () => {
  assert.equal(sslipEmbeddedIp(`garage.${MASTER}.sslip.io`), MASTER);
  assert.equal(sslipEmbeddedIp(`web-ui.garage.${MASTER}.sslip.io`), MASTER);
  assert.equal(sslipEmbeddedIp("garage.example.com"), null);
  // Not anchored at the end (trailing path) → not a bare host, so null.
  assert.equal(sslipEmbeddedIp(`https://garage.${MASTER}.sslip.io/x`), null);
});

test("rehostSslip moves the primary auto domain to the remote IP", () => {
  assert.equal(
    rehostSslip(`garage-s3-with-web-ui.${MASTER}.sslip.io`, REMOTE),
    `garage-s3-with-web-ui.${REMOTE}.sslip.io`,
  );
});

test("rehostSslip moves a web-ui.* extra (exposes[].host) to the remote IP", () => {
  assert.equal(
    rehostSslip(`web-ui.garage-s3-with-web-ui.${MASTER}.sslip.io`, REMOTE),
    `web-ui.garage-s3-with-web-ui.${REMOTE}.sslip.io`,
  );
});

test("rehostSslip is a no-op for a non-sslip host", () => {
  assert.equal(rehostSslip("garage.example.com", REMOTE), "garage.example.com");
});

test("rehostEmbeddedSslip rewrites the host inside a free-text env value, keeping surrounding text", () => {
  assert.equal(
    rehostEmbeddedSslip(`https://garage.${MASTER}.sslip.io/health`, MASTER, REMOTE),
    `https://garage.${REMOTE}.sslip.io/health`,
  );
});

test("rehostEmbeddedSslip rewrites every occurrence in one value", () => {
  const v = `A=http://a.${MASTER}.sslip.io B=http://b.${MASTER}.sslip.io`;
  assert.equal(
    rehostEmbeddedSslip(v, MASTER, REMOTE),
    `A=http://a.${REMOTE}.sslip.io B=http://b.${REMOTE}.sslip.io`,
  );
});

test("rehostEmbeddedSslip only touches the matching fromIp (leaves other sslip hosts alone)", () => {
  const other = "10.0.0.9";
  assert.equal(
    rehostEmbeddedSslip(`x.${other}.sslip.io`, MASTER, REMOTE),
    `x.${other}.sslip.io`,
  );
});

test("rehostEmbeddedSslip is a no-op when the value has no sslip host", () => {
  // garage's real env uses internal service DNS, never the public host — untouched.
  assert.equal(
    rehostEmbeddedSslip("http://garage:3900", MASTER, REMOTE),
    "http://garage:3900",
  );
});

test("the fromIp dots are treated literally, not as regex wildcards", () => {
  // A value that would match if dots were wildcards but shouldn't here.
  const v = "x.95X135X208X208.sslip.io";
  assert.equal(rehostEmbeddedSslip(v, MASTER, REMOTE), v);
});

test("rehostBlueprintHosts moves the whole garage-with-ui blueprint to the remote IP", () => {
  // Exactly what the /new page bakes for garage-with-ui against the master IP.
  const baked = {
    autoDomain: `garage-s3-with-web-ui.${MASTER}.sslip.io`,
    exposes: [
      { service: "garage", port: 3900, host: `garage-s3-with-web-ui.${MASTER}.sslip.io` },
      { service: "garage-webui", port: 3909, host: `web-ui.garage-s3-with-web-ui.${MASTER}.sslip.io` },
    ],
    // garage's env uses internal DNS, so it should pass through untouched; add a
    // synthetic public-host env to prove that case is rewritten too.
    env: [
      { key: "S3_ENDPOINT_URL", value: "http://garage:3900" },
      { key: "PUBLIC_URL", value: `https://garage-s3-with-web-ui.${MASTER}.sslip.io` },
    ],
  };
  const moved = rehostBlueprintHosts(baked, MASTER, REMOTE);
  assert.equal(moved.autoDomain, `garage-s3-with-web-ui.${REMOTE}.sslip.io`);
  assert.deepEqual(moved.exposes, [
    { service: "garage", port: 3900, host: `garage-s3-with-web-ui.${REMOTE}.sslip.io` },
    { service: "garage-webui", port: 3909, host: `web-ui.garage-s3-with-web-ui.${REMOTE}.sslip.io` },
  ]);
  assert.deepEqual(moved.env, [
    { key: "S3_ENDPOINT_URL", value: "http://garage:3900" },
    { key: "PUBLIC_URL", value: `https://garage-s3-with-web-ui.${REMOTE}.sslip.io` },
  ]);
});

test("rehostBlueprintHosts is a no-op when the project targets the master (same IP)", () => {
  const baked = {
    autoDomain: `app.${MASTER}.sslip.io`,
    exposes: [{ service: "web", port: 80, host: `app.${MASTER}.sslip.io` }],
    env: [{ key: "X", value: "1" }],
  };
  // Same fromIp/toIp ⇒ the exact input is returned (callers can call blindly).
  assert.equal(rehostBlueprintHosts(baked, MASTER, MASTER), baked);
});

test("rehostBlueprintHosts does not mutate its input", () => {
  const baked = {
    autoDomain: `app.${MASTER}.sslip.io`,
    exposes: [{ service: "web", port: 80, host: `app.${MASTER}.sslip.io` }],
    env: [{ key: "X", value: `http://app.${MASTER}.sslip.io` }],
  };
  const moved = rehostBlueprintHosts(baked, MASTER, REMOTE);
  assert.notEqual(moved, baked);
  assert.equal(baked.autoDomain, `app.${MASTER}.sslip.io`, "input.autoDomain untouched");
  assert.equal(baked.exposes[0].host, `app.${MASTER}.sslip.io`, "input.exposes untouched");
  assert.equal(baked.env[0].value, `http://app.${MASTER}.sslip.io`, "input.env untouched");
});

test("rehostBlueprintHosts handles a project with no blueprint fields", () => {
  const moved = rehostBlueprintHosts(
    { autoDomain: null, exposes: null },
    MASTER,
    REMOTE,
  );
  assert.equal(moved.autoDomain, null);
  assert.equal(moved.exposes, null);
});
