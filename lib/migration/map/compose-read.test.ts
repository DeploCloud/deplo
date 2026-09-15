import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeAsRepoApp,
  composeBuildServices,
  composeServiceExposingPort,
} from "./compose-read";
import { composeVolumeMounts } from "./volume-discovery";

test("a git-backed compose that is one build IS an app, not a stack", () => {
  const one = `
services:
  app:
    build: .
    expose:
      - 3000
    volumes:
      - aboutme_data:/app/data
volumes:
  aboutme_data:
`;
  assert.deepEqual(composeAsRepoApp(one), { service: "app" });
  assert.deepEqual(composeVolumeMounts(one), [
    { name: "aboutme_data", mountPath: "/app/data" },
  ]);

  assert.deepEqual(
    composeAsRepoApp(`
services:
  site:
    build:
      context: ./web
      dockerfile: docker/Dockerfile
      target: runner
`),
    {
      service: "site",
      dockerContextPath: "./web",
      dockerfilePath: "docker/Dockerfile",
      dockerBuildStage: "runner",
    },
  );
  assert.equal(
    composeAsRepoApp("services:\n  a:\n    build:\n      context: .\n")
      ?.dockerContextPath,
    undefined,
  );

  assert.equal(
    composeAsRepoApp(`
services:
  site:
    build: .
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
`),
    null,
  );
  assert.equal(composeAsRepoApp("services:\n  a:\n    image: nginx\n"), null);
  assert.equal(composeAsRepoApp("not: yaml: ["), null);
});

test("a stack that stays a stack names the services it cannot build", () => {
  assert.deepEqual(
    composeBuildServices(`
services:
  site:
    build: .
  worker:
    build:
      context: .
  db:
    image: postgres:16
`),
    ["site", "worker"],
  );
  assert.deepEqual(
    composeBuildServices("services:\n  a:\n    image: nginx\n"),
    [],
  );
});

test("composeServiceExposingPort answers only when it is not a guess", () => {
  const svc = (body: string) => `services:\n${body}`;
  assert.equal(
    composeServiceExposingPort(svc("  only:\n    image: a\n")),
    "only",
    "one service is the answer whether or not it declares a port",
  );
  assert.equal(
    composeServiceExposingPort(
      svc(
        "  web:\n    image: a\n    ports:\n      - 80:80\n  db:\n    image: b\n",
      ),
    ),
    "web",
  );
  assert.equal(
    composeServiceExposingPort(
      svc(
        "  web:\n    image: a\n    expose:\n      - 3000\n  db:\n    image: b\n",
      ),
    ),
    "web",
    "`expose` counts too - a stack behind a proxy publishes nothing",
  );
  assert.equal(
    composeServiceExposingPort(
      svc(
        "  a:\n    image: a\n    ports:\n      - 80:80\n  b:\n    image: b\n    ports:\n      - 90:90\n",
      ),
    ),
    null,
  );
  assert.equal(composeServiceExposingPort("  not: yaml: at all"), null);
  assert.equal(composeServiceExposingPort(null), null);
});
