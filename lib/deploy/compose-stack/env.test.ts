import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../../yaml";

import { buildComposeStack } from "./render";
import { buildDoc, envOf, route, type Doc } from "./stack-test-helpers";

test("envKeys inject bare `- KEY` pass-throughs into EVERY service", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
  db:
    image: postgres
`,
    {
      envKeys: ["FOO", "BAR"],
      domainRoutes: [route("demo.1.2.3.4.deplo.site", "web", 80)],
    },
  );
  assert.deepEqual(envOf(doc.services.web), ["FOO", "BAR"]);
  assert.deepEqual(envOf(doc.services.db), ["FOO", "BAR"]);
});

test("a key the service already declares (map value) is NOT overridden", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      FOO: hardcoded
`,
    { envKeys: ["FOO", "BAR"] },
  );
  const env = envOf(doc.services.web);
  assert.ok(env.includes("FOO=hardcoded"));
  assert.ok(env.includes("BAR"));
  assert.ok(!env.includes("FOO"), "FOO must not be duplicated as a bare key");
});

test("a key the service already declares (list `KEY=value`) is NOT overridden", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      - FOO=hardcoded
`,
    { envKeys: ["FOO", "BAR"] },
  );
  const env = envOf(doc.services.web);
  assert.deepEqual(env, ["FOO=hardcoded", "BAR"]);
});

test("a key the service already declares as a bare pass-through is kept once", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      - FOO
`,
    { envKeys: ["FOO", "BAR"] },
  );
  const env = envOf(doc.services.web);
  assert.deepEqual(env, ["FOO", "BAR"]);
});

test("a user `KEY=${VAR}` interpolation is preserved, not clobbered", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      - DATABASE_URL=postgres://app:\${DB_PASSWORD}@db:5432/app
`,
    { envKeys: ["DATABASE_URL", "DB_PASSWORD"] },
  );
  const env = envOf(doc.services.web);
  assert.ok(
    env.includes("DATABASE_URL=postgres://app:${DB_PASSWORD}@db:5432/app"),
  );
  assert.ok(env.includes("DB_PASSWORD"));
});

test("empty envKeys ⇒ services with NO environment stay untouched", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
`);
  assert.equal(doc.services.web.environment, undefined);
});

test("a map service whose keys are all already declared is left as a MAP (no churn)", () => {
  const out = buildComposeStack({
    network: "deplo-team-team_test",
    compose: `
services:
  web:
    image: nginx
    environment:
      FOO: a
      BAR: b
`,
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.deplo.site", "web", 80)],
    envKeys: ["FOO", "BAR"],
  });
  const doc = yaml.load(out) as Doc;
  assert.ok(
    !Array.isArray(doc.services.web.environment) &&
      typeof doc.services.web.environment === "object",
  );
});

test("a `KEY:` map entry with a null value stays a bare pass-through when re-listed", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    environment:
      EXISTING:
`,
    { envKeys: ["NEWKEY"] },
  );
  const env = envOf(doc.services.web);
  assert.deepEqual(env, ["EXISTING", "NEWKEY"]);
});

test("the env text the author typed is the text the container gets", () => {
  const doc = buildDoc(`x-common: &common
  environment:
    UMASK: 022
services:
  web:
    image: nginx
    environment:
      VER: 1.10
      PORT: 8080
      OK: true
      TXT: hello
  side:
    <<: *common
    image: alpine
`);
  const env = doc.services.web.environment as unknown as Record<
    string,
    unknown
  >;
  assert.equal(env.VER, "1.10");
  assert.equal(
    (doc.services.side.environment as unknown as Record<string, unknown>).UMASK,
    "022",
  );
  assert.equal(env.PORT, 8080);
  assert.equal(env.OK, true);
  assert.equal(env.TXT, "hello");
});

test("a compose that needs no requoting is read as it was", () => {
  const doc = buildDoc(
    "services:\n  web:\n    image: nginx\n    environment:\n      A: '1'\n",
  );
  assert.deepEqual(doc.services.web.environment, { A: "1" });
});
