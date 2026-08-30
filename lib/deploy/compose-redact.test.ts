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

/**
 * A multi-line value is a value.
 */
test("a block scalar is masked whole, body and all", () => {
  const out = redactComposeForDisplay(`services:
  app:
    image: gitlab/gitlab-ce:17
    environment:
      SIMPLE: plain-secret
      GITLAB_OMNIBUS_CONFIG: |
        external_url 'https://git.example.com'
        gitlab_rails['smtp_password'] = 'SUPERSECRET'
      PRIVATE_KEY: |-
        -----BEGIN PRIVATE KEY-----
        MIIEvQIBADANBg

        -----END PRIVATE KEY-----
      AFTER: another-secret
    ports:
      - "80:80"
`);
  assert.ok(!out.includes("SUPERSECRET"));
  assert.ok(!out.includes("BEGIN PRIVATE KEY"));
  assert.ok(!out.includes("MIIEvQIBADANBg"));
  assert.ok(!out.includes("external_url"));
  // The keys still show, and the value after the block is masked normally -
  // swallowing the body must not swallow the rest of the environment.
  assert.ok(out.includes(`GITLAB_OMNIBUS_CONFIG: "${MASKED}"`));
  assert.ok(out.includes(`PRIVATE_KEY: "${MASKED}"`));
  assert.ok(out.includes(`AFTER: "${MASKED}"`));
  // Everything outside `environment:` is untouched.
  assert.ok(out.includes('- "80:80"'));
  assert.ok(out.includes("image: gitlab/gitlab-ce:17"));
});

test("every block-scalar spelling is recognised", () => {
  for (const marker of ["|", "|-", "|+", ">", ">-", ">2"]) {
    const out = redactComposeForDisplay(`services:
  app:
    environment:
      K: ${marker}
        leaked-value
    image: nginx
`);
    assert.ok(!out.includes("leaked-value"), `body survived after ${marker}`);
    assert.ok(out.includes("image: nginx"), `stack truncated after ${marker}`);
  }
});
