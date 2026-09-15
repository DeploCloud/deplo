import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../../yaml";
import { adaptComposeForDeplo } from "./compose-adapt";

test("adaptComposeForDeplo leaves a clean compose byte-identical", () => {
  const source = "services:\n  web:\n    image: nginx # keep this comment\n";
  const { compose, changes } = adaptComposeForDeplo(source);
  assert.deepEqual(changes, []);
  assert.equal(compose, source);
});

test("adaptComposeForDeplo does not throw on YAML it cannot parse", () => {
  const broken = "services:\n  web:\n   - : :";
  assert.deepEqual(adaptComposeForDeplo(broken), {
    compose: broken,
    changes: [],
  });
});

test("adaptComposeForDeplo leaves a stack that needs neither rewrite alone", () => {
  const source =
    "services:\n  web:\n    image: nginx\n    volumes:\n      - data:/data\nvolumes:\n  data:\n";
  assert.deepEqual(adaptComposeForDeplo(source), {
    compose: source,
    changes: [],
  });
});

test("the rewrite hands the file back the way its author wrote it", () => {
  const src = `# an imported stack
x-common: &common
  restart: unless-stopped # keep me
  networks: [dokploy-network]
services:
  app:
    <<: *common
    image: nginx
    volumes:
      - ../files/x.conf:/etc/x.conf
networks:
  dokploy-network:
    external: true
`;
  const { compose, changes } = adaptComposeForDeplo(src);
  assert.equal(changes.length, 2, changes.join(" | "));
  assert.match(compose, /^# an imported stack$/m);
  assert.match(compose, /x-common: &common/);
  assert.match(compose, /<<: \*common/);
  assert.match(compose, /restart: unless-stopped # keep me/);
  assert.equal(compose.includes("dokploy-network"), false, compose);
  assert.match(compose, /- \.\/x\.conf:\/etc\/x\.conf/);
});

test("an env value the author typed as text survives the rewrite", () => {
  const src = `services:
  app:
    image: x
    networks: [dokploy-network]
    environment:
      UMASK: 022
      VER: 1.10
      PORT: 8080
      OK: true
networks:
  dokploy-network: {external: true}
`;
  const { compose } = adaptComposeForDeplo(src);
  const env = (
    yaml.load(compose) as {
      services: { app: { environment: Record<string, unknown> } };
    }
  ).services.app.environment;
  assert.equal(env.UMASK, "022");
  assert.equal(env.VER, "1.10");
  assert.equal(env.PORT, 8080);
  assert.equal(env.OK, true);
});
