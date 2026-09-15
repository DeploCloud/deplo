import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../../yaml";
import { adaptComposeForDeplo } from "./compose-adapt";
import { composeVolumeMounts } from "./volume-discovery";

test("adaptComposeForDeplo points a stack's storage at its own volumes", () => {
  const source = [
    "services:",
    "  core:",
    "    image: alpine",
    "    volumes:",
    "      - ext:/data/ext",
    "      - dopts:/data/dopts",
    "      - mine:/data/mine",
    "volumes:",
    "  ext:",
    "    external: true",
    "    name: r9-external-vol",
    "  dopts:",
    "    driver_opts:",
    "      type: none",
    "      device: /srv/r9-dopts",
    "      o: bind",
    "  mine:",
  ].join("\n");

  const { compose, changes } = adaptComposeForDeplo(source);
  const doc = yaml.load(compose) as { volumes: Record<string, unknown> };
  assert.equal(doc.volumes.ext, null);
  assert.equal(doc.volumes.dopts, null);
  assert.equal(doc.volumes.mine, null);
  assert.equal(
    changes.filter((c) => c.includes("outside this stack")).length,
    2,
  );
  assert.ok(changes.some((c) => c.includes("/srv/r9-dopts on the server")));
});

test("adaptComposeForDeplo declares a volume the file only mounts", () => {
  const source =
    "services:\n  web:\n    image: nginx\n    volumes:\n      - data:/data\n      - ./conf:/etc/conf\n      - /var/run/docker.sock:/sock\n";
  const { compose, changes } = adaptComposeForDeplo(source);
  assert.match(compose, /^volumes:\n  data: null$/m);
  assert.equal(compose.match(/- data:\/data/g)?.length, 1);
  assert.equal(changes.length, 1);
  assert.match(changes[0], /^data is declared at the top/);
  assert.doesNotMatch(compose, /\n {2}\.\/conf:/);
  assert.doesNotMatch(compose, /\n {2}\/var:/);
});

test("adaptComposeForDeplo declares a long-form volume, never a long-form bind", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "    volumes:",
    "      - type: volume",
    "        source: mydata",
    "        target: /var/lib/x",
    "      - type: bind",
    "        source: /srv/y",
    "        target: /y",
    "",
  ].join("\n");
  const { compose } = adaptComposeForDeplo(source);
  assert.match(compose, /^volumes:\n  mydata: null$/m);
  assert.doesNotMatch(compose, /\/srv\/y: null/);
});

test("adaptComposeForDeplo takes the slash off a volume NAME", () => {
  const source =
    "services:\n  memos:\n    image: memos\n    volumes:\n      - 'memos/:/var/opt/memos'\n";
  const { compose, changes } = adaptComposeForDeplo(source);
  const doc = yaml.load(compose) as {
    services: Record<string, { volumes: string[] }>;
    volumes: Record<string, unknown>;
  };
  assert.deepEqual(doc.services.memos.volumes, ["memos:/var/opt/memos"]);
  assert.deepEqual(Object.keys(doc.volumes), ["memos"]);
  assert.ok(changes.some((c) => c.startsWith("memos/ is a volume name")));
  assert.deepEqual(composeVolumeMounts(compose), [
    { name: "memos", mountPath: "/var/opt/memos" },
  ]);
});

test("a path is never mistaken for a slashed volume name", () => {
  const source = [
    "services:",
    "  a:",
    "    image: x",
    "    volumes:",
    "      - ./conf/:/etc/conf",
    "      - /srv/data/:/data",
    "      - type: volume",
    "        source: cache/",
    "        target: /cache",
    "",
  ].join("\n");
  const { compose } = adaptComposeForDeplo(source);
  const doc = yaml.load(compose) as {
    services: Record<string, { volumes: unknown[] }>;
    volumes?: Record<string, unknown>;
  };
  assert.deepEqual(doc.services.a.volumes, [
    "./conf/:/etc/conf",
    "/srv/data/:/data",
    { type: "volume", source: "cache", target: "/cache" },
  ]);
  assert.deepEqual(Object.keys(doc.volumes ?? {}), ["cache"]);
});
