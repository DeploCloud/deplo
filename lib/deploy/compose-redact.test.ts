import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MASKED,
  maskBasicAuthLabel,
  redactComposeForDisplay,
} from "./compose-redact";

/**
 * "View full compose" is served at the `view` floor, so everything the render
 * RESOLVES into the file has to be masked on the way out.
 *
 * The env pass was there from the start. The basic-auth htpasswd line was not:
 * it rides a Traefik LABEL, nowhere near `environment:`, so any member of the
 * team could read `user:$$2y$$10$$<hash>` out of the preview while managing those
 * credentials takes `manage_basic_auth`.
 */

const HTPASSWD =
  "alice:$$2y$$10$$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

test("the basic-auth label is masked in list form", () => {
  const line = `      - "traefik.http.middlewares.deplo-ba-1a2b3c.basicauth.users=${HTPASSWD}"`;
  const out = maskBasicAuthLabel(line);
  assert.ok(out);
  assert.ok(!out.includes("2y$$10"));
  assert.ok(!out.includes("alice"));
  assert.ok(out.includes(`basicauth.users=${MASKED}`));
});

test("the basic-auth label is masked in map form too", () => {
  const line = `      traefik.http.middlewares.deplo-ba-1a2b3c.basicauth.users: "${HTPASSWD}"`;
  const out = maskBasicAuthLabel(line);
  assert.ok(out);
  assert.ok(!out.includes("alice"));
  assert.ok(out.includes(`basicauth.users: ${MASKED}`));
});

test("a line with no such label is left alone", () => {
  assert.equal(maskBasicAuthLabel("      - traefik.enable=true"), null);
});

test("a whole rendered stack loses its env values AND its htpasswd", () => {
  const yaml = [
    "services:",
    "  app:",
    "    image: nginx:1.27",
    "    environment:",
    '      - "DATABASE_URL=postgres://u:p@db/x"',
    "      - PASSTHROUGH",
    "      API_KEY: sk-live-1234567890",
    "    labels:",
    "      - traefik.enable=true",
    `      - "traefik.http.middlewares.deplo-ba-9z.basicauth.users=${HTPASSWD}"`,
    "      - traefik.http.routers.app.rule=Host(`app.example.com`)",
  ].join("\n");

  const out = redactComposeForDisplay(yaml);

  // Values gone, names kept.
  assert.ok(!out.includes("postgres://u:p@db/x"));
  assert.ok(!out.includes("sk-live-1234567890"));
  assert.ok(out.includes("DATABASE_URL="));
  assert.ok(out.includes("API_KEY:"));
  assert.ok(out.includes("- PASSTHROUGH"));
  // The credential is gone, and the rest of the routing is untouched.
  assert.ok(!out.includes("alice"));
  assert.ok(!out.includes("2y$$10"));
  assert.ok(out.includes("traefik.enable=true"));
  assert.ok(out.includes("Host(`app.example.com`)"));
});

test("a stack with nothing to hide is returned byte-identical", () => {
  const yaml = ["services:", "  app:", "    image: nginx:1.27", ""].join("\n");
  assert.equal(redactComposeForDisplay(yaml), yaml);
});
