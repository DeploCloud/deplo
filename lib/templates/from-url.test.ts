import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  __resetDnsLookupForTest,
  __setDnsLookupForTest,
} from "../outbound-url";
import { composeOrigin, loadComposeFromUrl, rawComposeUrl } from "./from-url";

const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n";
const BLOB = "https://github.com/acme/app/blob/v1.2.0/docker-compose.yml";
const RAW =
  "https://raw.githubusercontent.com/acme/app/v1.2.0/docker-compose.yml";
const DIR = "https://raw.githubusercontent.com/acme/app/v1.2.0/";

before(() => {
  __setDnsLookupForTest(async (host) =>
    host === "internal.example"
      ? [{ address: "10.0.0.5" }]
      : [{ address: "93.184.216.34" }],
  );
});
after(() => __resetDnsLookupForTest());

async function withFiles(
  files: Record<string, Response | (() => Response)>,
  run: (asked: string[]) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    const hit = files[String(url)];
    if (!hit) return new Response("nope", { status: 404 });
    return typeof hit === "function" ? hit() : hit;
  }) as typeof fetch;
  try {
    await run(asked);
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (body: BodyInit) => new Response(body, { status: 200 });

test("rawComposeUrl: GitHub and GitLab page links become raw file links", () => {
  assert.equal(rawComposeUrl(BLOB), RAW);
  assert.equal(
    rawComposeUrl("https://github.com/acme/app/raw/main/stack/compose.yml"),
    "https://raw.githubusercontent.com/acme/app/main/stack/compose.yml",
  );
  assert.equal(
    rawComposeUrl("https://git.acme.dev/team/app/-/blob/main/compose.yml"),
    "https://git.acme.dev/team/app/-/raw/main/compose.yml",
  );
  assert.equal(rawComposeUrl(RAW), RAW);
});

test("composeOrigin: labels the repository, names the folder or the repo", () => {
  assert.deepEqual(composeOrigin(BLOB), {
    label: "github.com/acme/app",
    name: "app",
  });
  assert.deepEqual(
    composeOrigin(
      "https://github.com/acme/stacks/blob/main/apps/grafana/docker-compose.yml",
    ),
    { label: "github.com/acme/stacks", name: "grafana" },
  );
  assert.deepEqual(
    composeOrigin(
      "https://github.com/DeploCloud/templates/blob/main/src/templates/actual-budget/default/docker-compose.yml",
    ),
    { label: "github.com/DeploCloud/templates", name: "actual-budget" },
  );
  assert.deepEqual(
    composeOrigin("https://github.com/acme/app/blob/main/default/compose.yml"),
    { label: "github.com/acme/app", name: "app" },
  );
  assert.deepEqual(
    composeOrigin("https://gitlab.com/team/app/-/blob/main/compose.yml"),
    { label: "gitlab.com/team/app", name: "app" },
  );
  assert.deepEqual(
    composeOrigin("https://cdn.acme.com/stacks/wiki/compose.yml"),
    { label: "cdn.acme.com/stacks/wiki", name: "wiki" },
  );
});

test("loadComposeFromUrl: a bare compose loads, missing siblings are fine", async () => {
  await withFiles({ [RAW]: ok(COMPOSE) }, async (asked) => {
    const res = await loadComposeFromUrl(BLOB);
    assert.ok(res.ok);
    assert.equal(res.compose, COMPOSE);
    assert.equal(res.config, "");
    assert.equal(res.logo, null);
    assert.equal(res.name, "app");
    assert.equal(res.origin, "github.com/acme/app");
    assert.ok(asked.includes(`${DIR}template.toml`));
  });
});

test("loadComposeFromUrl: template.toml, a PNG logo and the compose name are picked up", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await withFiles(
    {
      [RAW]: ok(`name: wiki\n${COMPOSE}`),
      [`${DIR}template.toml`]: ok('[variables]\npw = "${password:8}"\n'),
      [`${DIR}logo.png`]: ok(png),
    },
    async () => {
      const res = await loadComposeFromUrl(RAW);
      assert.ok(res.ok);
      assert.match(res.config, /\[variables\]/);
      assert.equal(res.logo, `data:image/png;base64,${png.toString("base64")}`);
      assert.equal(res.name, "wiki");
    },
  );
});

test("loadComposeFromUrl: a logo that is not what its name says is ignored", async () => {
  await withFiles(
    { [RAW]: ok(COMPOSE), [`${DIR}logo.png`]: ok("<html>login</html>") },
    async () => {
      const res = await loadComposeFromUrl(RAW);
      assert.ok(res.ok);
      assert.equal(res.logo, null);
    },
  );
});

test("loadComposeFromUrl: a redirect into a private address is refused", async () => {
  await withFiles(
    {
      [RAW]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://internal.example/compose.yml" },
        }),
    },
    async () => {
      const res = await loadComposeFromUrl(RAW);
      assert.equal(res.ok, false);
      assert.match(!res.ok ? res.error : "", /private or internal/);
    },
  );
});

test("loadComposeFromUrl: refuses what it cannot deploy", async () => {
  const refused = async (
    files: Record<string, Response>,
    url: string,
    why: RegExp,
  ) =>
    withFiles(files, async () => {
      const res = await loadComposeFromUrl(url);
      assert.equal(res.ok, false, url);
      assert.match(!res.ok ? res.error : "", why);
    });
  await refused({}, "http://example.com/compose.yml", /https/);
  await refused({}, "not a url", /valid URL/);
  await refused({}, RAW, /has no file at this address/);
  await refused({ [RAW]: ok("x".repeat(300 * 1024)) }, RAW, /too large/);
  await refused({ [RAW]: ok("hello: world\n") }, RAW, /no services/);
  await refused(
    { [RAW]: ok("services:\n  api:\n    build: .\n") },
    RAW,
    /"api" service builds from source/,
  );
  await refused(
    {
      [RAW]: ok(COMPOSE),
      [`${DIR}template.toml`]: new Response("", { status: 500 }),
    },
    RAW,
    /answered 500 for template\.toml/,
  );
});
