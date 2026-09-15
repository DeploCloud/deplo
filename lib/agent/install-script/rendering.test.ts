import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { renderInstallScript } from "../install-script";
import { __resetReleaseCacheForTests } from "../release";
import { FAKE, shVar, stubReleaseFetch } from "./install-script-test-helpers";

afterEach(() => {
  __resetReleaseCacheForTests();
});

test("renderInstallScript substitutes per-arch URLs + sha256 from the release", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script, "expected a rendered script (release resolvable)");
    assert.equal(shVar(script!, "AGENT_VERSION"), "2.3.0");
    assert.equal(shVar(script!, "AGENT_URL_AMD64"), FAKE.amd64Url);
    assert.equal(shVar(script!, "AGENT_SHA256_AMD64"), FAKE.amd64Sha);
    assert.equal(shVar(script!, "AGENT_URL_ARM64"), FAKE.arm64Url);
    assert.equal(shVar(script!, "AGENT_SHA256_ARM64"), FAKE.arm64Sha);
  } finally {
    restore();
  }
});

test("renderInstallScript returns null when no release can be resolved", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("not found", { status: 404 })) as typeof fetch;
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.equal(
      script,
      null,
      "unresolvable release must 503 (null), not serve unverifiable installer",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("rendered script does NOT contain an unsubstituted sentinel token", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script);
    assert.ok(
      !script!.includes("__AGENT_URL_AMD64__"),
      "still contains __AGENT_URL_AMD64__",
    );
    assert.ok(!script!.includes("__AGENT_SHA256_AMD64__"));
    assert.ok(!script!.includes("__AGENT_VERSION__"));
  } finally {
    restore();
  }
});

test("the self-guard PASSES on the rendered script (would-fire bug regression)", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script);
    const url = shVar(script!, "AGENT_URL_AMD64")!;
    assert.ok(
      !guardMatches(url),
      "rendered AGENT_URL_AMD64 trips the install guard - the script can never run",
    );
  } finally {
    restore();
  }
});

test("the self-guard FIRES on the raw repo template", async () => {
  const template = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  const url = shVar(template, "AGENT_URL_AMD64")!;
  assert.ok(
    guardMatches(url),
    "raw template AGENT_URL_AMD64 must trip the guard (refuse the repo copy)",
  );
});

function guardMatches(url: string): boolean {
  return /__AGENT_URL.*AMD64__/.test(url);
}
