import { test } from "node:test";
import assert from "node:assert/strict";

import { MASKED, redactComposeForDisplay } from "./compose-redact";
import yaml from "../yaml";

const HTPASSWD =
  "alice:$$2y$$10$$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

function assertNoLeak(out: string) {
  assert.ok(!/s3cret/i.test(out), `a secret survived:\n${out}`);
  yaml.load(out);
}

test("a whole rendered stack loses its env values AND its htpasswd", () => {
  const out = redactComposeForDisplay(
    [
      "services:",
      "  app:",
      "    image: nginx:1.27",
      "    environment:",
      '      - "DATABASE_URL=postgres://u:p@db/x"',
      "      - PASSTHROUGH",
      "    labels:",
      "      - traefik.enable=true",
      `      - "traefik.http.middlewares.deplo-ba-9z.basicauth.users=${HTPASSWD}"`,
      "      - traefik.http.routers.app.rule=Host(`app.example.com`)",
      "      - traefik.http.services.app.loadbalancer.server.port=3000",
    ].join("\n"),
  );
  assert.ok(!out.includes("postgres://u:p@db/x"));
  assert.ok(out.includes(`DATABASE_URL=${MASKED}`));
  assert.ok(out.includes("- PASSTHROUGH"));
  assert.ok(!out.includes("alice"));
  assert.ok(out.includes(`basicauth.users=${MASKED}`));
  assert.ok(out.includes("traefik.enable=true"));
  assert.ok(out.includes("Host(`app.example.com`)"));
  assert.ok(out.includes("loadbalancer.server.port=3000"));
});

test("a stack with nothing to hide is returned byte-identical", () => {
  const src = ["services:", "  app:", "    image: nginx:1.27", ""].join("\n");
  assert.equal(redactComposeForDisplay(src), src);
});

test("flow maps, quoted keys and continued lines are masked", () => {
  const out = redactComposeForDisplay(`services:
  web:
    image: nginx
    environment: { DB_PASSWORD: s3cretFLOW, "QUOTED KEY": 's3cretQ' }
  api:
    image: api
    environment:
      - "A=s3cretLIST"
      - B=first
        s3cretCONT
`);
  assertNoLeak(out);
  assert.ok(out.includes(`DB_PASSWORD: "${MASKED}"`));
  assert.ok(out.includes(`"QUOTED KEY": "${MASKED}"`));
  assert.ok(out.includes(`"A=${MASKED}"`));
});

test("a block scalar and a merged anchor are masked at their source", () => {
  const out = redactComposeForDisplay(`x-env: &env
  DB_PASSWORD: s3cretANCHOR
services:
  web:
    image: &img nginx:1.27
    environment:
      <<: *env
      PRIVATE_KEY: |-
        -----BEGIN PRIVATE KEY-----
        s3cretBODY
      REUSED: &pw s3cretALIAS
    command: ["--password", *pw]
`);
  assertNoLeak(out);
  assert.ok(out.includes("<<: *env"));
  assert.ok(out.includes(`PRIVATE_KEY: "${MASKED}"`));
  assert.ok(out.includes("image: &img nginx:1.27"));
});

test("build args, command, healthcheck, labels and inline content are masked", () => {
  const out = redactComposeForDisplay(`services:
  test:
    image: redis
    build:
      context: https://oauth2:s3cretTOKEN@git.example.com/acme/app.git
      args:
        NPM_TOKEN: s3cretARGS
    command: redis-server --requirepass s3cretCMD
    healthcheck:
      test: ["CMD", "mysqladmin", "-ps3cretHC"]
    labels:
      com.example.api-key: s3cretLABEL
      traefik.http.middlewares.x.headers.customrequestheaders.Authorization: Bearer s3cretHDR
      deplo.slug: web
    x-notes: s3cretEXT
volumes:
  content:
    driver_opts:
      o: "username=u,password=s3cretCIFS"
secrets:
  api:
    content: s3cretINLINE
`);
  assertNoLeak(out);
  assert.ok(out.includes("deplo.slug: web"), "a routing label stays readable");
  assert.ok(out.includes("  test:"), "a service named like a rule is kept");
  assert.ok(out.includes("  content:"), "a volume named like a rule is kept");
  assert.ok(out.includes(`oauth2:${MASKED}@git.example.com`));
});

test("comments are dropped, since one can hold an old value", () => {
  const out = redactComposeForDisplay(`# DB_PASSWORD=s3cretTOP
services:
  web:
    image: nginx # s3cretINLINE
    environment:
      A: x
      # B: s3cretCOMMENTED
`);
  assertNoLeak(out);
  assert.ok(out.includes("image: nginx"));
});

test("an unreadable file is withheld whole", () => {
  const out = redactComposeForDisplay("services:\n  web: [\n    s3cret: x\n");
  assert.ok(!out.includes("s3cret"));
  assert.equal(yaml.load(out), null);
});
