import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../../yaml";
import {
  anchorSourcePaths,
  prepareSourceCompose,
  sourceComposeDir,
} from "./source-compose";

type Rec = Record<string, Record<string, Record<string, unknown>>>;
const opts = { deployKey: "shop", tag: "abc123" };
const prepared = (src: string) =>
  yaml.load(prepareSourceCompose(src, opts).yaml) as Rec;
const refused = (src: string, why: RegExp) =>
  assert.throws(() => prepareSourceCompose(src, opts), why);

test("a built service is tagged with Deplo's own name, never one another stack could pull", () => {
  const out = prepareSourceCompose(
    `services:
  web:
    build: .
    image: postgres:16
  api:
    build: { context: ./api, dockerfile: Dockerfile.prod }
  db:
    image: postgres:16
`,
    opts,
  );
  const doc = yaml.load(out.yaml) as Rec;
  assert.equal(doc.services.web.image, "deplo/shop-web:abc123");
  assert.deepEqual(doc.services.web.build, { context: "." });
  assert.equal(doc.services.api.image, "deplo/shop-api:abc123");
  assert.equal(
    doc.services.db.image,
    "postgres:16",
    "a pulled image is left alone",
  );
  assert.ok(out.notes.some((n) => /not postgres:16/.test(n)));
});

test("published ports become exposed ones, so the domain still finds the service", () => {
  const doc = prepared(`services:
  web:
    image: nginx
    ports: ["8080:80", "127.0.0.1:9000:9000/tcp", { target: 443, published: 8443 }]
    expose: ["3000"]
`);
  assert.equal(doc.services.web.ports, undefined);
  assert.deepEqual(doc.services.web.expose, ["3000", "80", "9000/tcp", "443"]);
});

test("an env_file the repository does not ship stops being a reason to fail", () => {
  const doc = prepared(`services:
  web:
    image: nginx
    env_file: .env
  worker:
    image: nginx
    env_file: [{ path: config/worker.env, required: true }]
`);
  assert.deepEqual(doc.services.web.env_file, [
    { path: ".env", required: false },
  ]);
  assert.deepEqual(doc.services.worker.env_file, [
    { path: "config/worker.env", required: false },
  ]);
});

test("anything that reaches the server itself is refused, whoever deploys", () => {
  refused(
    `services:\n  a:\n    image: x\n    privileged: true\n`,
    /reaches outside its containers/,
  );
  refused(
    `services:\n  a:\n    image: x\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n`,
    /reaches outside/,
  );
  refused(
    `services:\n  a:\n    image: x\n    volumes: ["../secrets:/s"]\n`,
    /reaches outside/,
  );
  refused(
    `services:\n  a:\n    image: x\n    volumes: ["\${DATA:-./data}:/data"]\n`,
    /reaches outside/,
  );
  refused(
    `services:\n  a:\n    image: x\n    cap_add: [SYS_ADMIN]\n`,
    /reaches outside/,
  );
  refused(
    `services:\n  a:\n    image: x\n    network_mode: host\n`,
    /reaches outside/,
  );
});

test("a build may not read or reach outside the repository", () => {
  // The host-reach gate refuses these first; the build rules behind it are the second lock.
  for (const src of [
    `services:\n  a:\n    build: ../other\n`,
    `services:\n  a:\n    build: /etc\n`,
    `services:\n  a:\n    build: { context: ., dockerfile: ../../Dockerfile }\n`,
    `services:\n  a:\n    build: { context: ., ssh: [default] }\n`,
    `services:\n  a:\n    build: { context: ., network: host }\n`,
    `services:\n  a:\n    build: { context: ., additional_contexts: ["x=../../"] }\n`,
    `services:\n  a:\n    image: x\n    env_file: ../.env\n`,
    `secrets:\n  k:\n    file: /root/.ssh/id_rsa\nservices:\n  a:\n    image: x\n`,
  ])
    refused(
      src,
      /reaches outside its containers|outside the repository|SSH keys|own network/,
    );
  refused(`include: [other.yml]\nservices:\n  a:\n    image: x\n`, /include/);
  refused(
    `services:\n  a:\n    extends: { file: base.yml, service: web }\n`,
    /extends another file/,
  );
  refused(`services: {}\n`, /no services/);
  refused(`services: [\n`, /not valid YAML/);
});

test("a remote build context names no path on the server, so it stays", () => {
  const doc = prepared(`services:
  a:
    build: { context: "https://github.com/acme/app.git#main", cache_from: ["type=local,src=/var/cache"] }
`);
  assert.deepEqual(doc.services.a.build, {
    context: "https://github.com/acme/app.git#main",
  });
});

test("at render every path resolves inside the agent's working copy", () => {
  const dir = sourceComposeDir("shop", "./apps/web");
  assert.equal(dir, "/data/stacks/shop.src/apps/web");
  assert.equal(sourceComposeDir("shop", ""), "/data/stacks/shop.src");
  const stored = prepareSourceCompose(
    `secrets:
  k:
    file: ./secret.txt
services:
  web:
    build: { context: ., additional_contexts: { assets: ./assets, base: "docker-image://alpine" } }
    env_file: .env
`,
    opts,
  ).yaml;
  const doc = yaml.load(anchorSourcePaths(stored, dir)) as Record<string, Rec>;
  const web = (doc.services as Rec).web;
  assert.deepEqual(web.build, {
    context: "/data/stacks/shop.src/apps/web",
    additional_contexts: {
      assets: "/data/stacks/shop.src/apps/web/assets",
      base: "docker-image://alpine",
    },
  });
  assert.deepEqual(web.env_file, [
    { path: "/data/stacks/shop.src/apps/web/.env", required: false },
  ]);
  assert.equal(
    (doc.secrets as Rec).k.file,
    "/data/stacks/shop.src/apps/web/secret.txt",
  );
});
